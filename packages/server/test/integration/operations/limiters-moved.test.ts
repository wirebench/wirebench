/**
 * Slice 5 Task 8 (hosted edition spec §20.7): every limiter that charges inside a tenant now keeps its buckets in
 * `limiter_buckets`. The suites the in-memory limiters had run here against the table, unchanged in what they
 * expect: identity's limiter (sign-in, SSO and SCIM, licensing, sync key requests, desktop audit events and the
 * agent's limits are all built from it), the agent's failed-pairing budget, and the catch URL buckets. Each limiter
 * gets an injected clock, as the modules' tests give theirs.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AGENT_RATE_LIMITS, PairingBudget } from '../../../src/agent/routes.js';
import { CatchBuckets, catchBucketKey } from '../../../src/hooks/rate-limit.js';
import { TenantRateLimiter, chargeKeys, emailKey, ipKey } from '../../../src/identity/rate-limit.js';
import { scimLimiterKey } from '../../../src/sso/scim/plugin.js';
import { TenantDirectory } from '../../../src/tenancy/directory.js';
import { scopeOf, type TenantScope } from '../../../src/tenancy/scope.js';
import { tenantDbFactory, type TenantDbFactory } from '../../../src/tenancy/tenant-db.js';
import { describeDb, testDatabase, type TestDatabase } from '../../helpers/database.js';

describeDb('the limiters on the shared table (hosted spec §20.7)', () => {
  let db: TestDatabase;
  let factory: TenantDbFactory;
  let ONE: TenantScope;
  let TWO: TenantScope;

  beforeAll(async () => {
    db = await testDatabase();
    const directory = new TenantDirectory(db);
    await directory.load();
    ONE = directory.defaultScope();
    const id = randomUUID();
    await db.owner.query('insert into tenants (id, slug, name) values ($1, $2, $3)', [id, 'two', 'Two']);
    TWO = scopeOf({ id, slug: 'two' });
    factory = tenantDbFactory(db);
  });
  afterAll(async () => {
    await db?.close();
  });

  /** A fresh key prefix per test, since the table outlives each test. */
  const fresh = (): string => randomUUID();

  describe('TenantRateLimiter (§3.6)', () => {
    const limiter = () => {
      let now = Date.parse('2026-11-04T12:00:00Z');
      const limit = new TenantRateLimiter({
        name: 'test',
        capacity: 10,
        refillPerMs: 10 / 60_000,
        db: factory,
        now: () => now,
      });
      return { limit, tick: (ms: number) => (now += ms) };
    };
    it('allows ten attempts a minute per key, then refuses with a Retry-After', async () => {
      const { limit } = limiter();
      const k = fresh();
      for (let i = 0; i < 10; i += 1) expect((await limit.take(ONE, `${k}:ip:1`)).allowed).toBe(true);
      const refused = await limit.take(ONE, `${k}:ip:1`);
      expect(refused.allowed).toBe(false);
      expect(refused.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(refused.retryAfterSeconds).toBeLessThanOrEqual(6);
      expect((await limit.take(ONE, `${k}:ip:2`)).allowed).toBe(true);
    });
    it('refills one attempt every six seconds and never beyond the capacity', async () => {
      const { limit, tick } = limiter();
      const k = fresh();
      for (let i = 0; i < 10; i += 1) await limit.take(ONE, k);
      tick(6_000);
      expect((await limit.take(ONE, k)).allowed).toBe(true);
      expect((await limit.take(ONE, k)).allowed).toBe(false);
      tick(600_000);
      for (let i = 0; i < 10; i += 1) expect((await limit.take(ONE, k)).allowed).toBe(true);
      expect((await limit.take(ONE, k)).allowed).toBe(false);
    });
    it('peeks without taking an attempt', async () => {
      const { limit, tick } = limiter();
      const k = fresh();
      expect((await limit.peek(ONE, k)).allowed).toBe(true);
      for (let i = 0; i < 10; i += 1) await limit.take(ONE, k);
      for (let i = 0; i < 3; i += 1) expect((await limit.peek(ONE, k)).allowed).toBe(false);
      expect((await limit.peek(ONE, k)).retryAfterSeconds).toBeGreaterThanOrEqual(1);
      tick(6_000);
      expect((await limit.peek(ONE, k)).allowed).toBe(true);
      expect((await limit.peek(ONE, k)).allowed).toBe(true);
      expect((await limit.take(ONE, k)).allowed).toBe(true);
      expect((await limit.peek(ONE, k)).allowed).toBe(false);
    });
    it('charges outside a unit the caller has open, so a failing unit keeps the charge', async () => {
      const { limit } = limiter();
      const k = fresh();
      await expect(
        factory(ONE).transaction(async () => {
          for (let i = 0; i < 10; i += 1) await limit.take(ONE, k);
          throw new Error('the request failed');
        }),
      ).rejects.toThrow('the request failed');
      expect((await limit.take(ONE, k)).allowed).toBe(false);
    });
  });

  it('keeps two limiters with one key apart, as their two in-memory maps were', async () => {
    const make = (name: string) =>
      new TenantRateLimiter({ name, capacity: 10, refillPerMs: 10 / 60_000, db: factory, now: () => 0 });
    // Sign-in and the agent's pairing both key an address `<tenant>:ip:<address>`.
    const signIn = make('identity');
    const pairing = make('agent-pairPerAddress');
    const key = `${ONE.tenantId}:ip:${fresh()}`;
    for (let i = 0; i < 10; i += 1) await signIn.take(ONE, key);
    expect((await signIn.take(ONE, key)).allowed).toBe(false);
    expect((await pairing.take(ONE, key)).allowed).toBe(true);
  });

  describe('the sign-in limiter keys (hosted edition spec §19.8 guard 5)', () => {
    const request = (tenant: TenantScope, ip: string) =>
      ({ tenant, ip, body: { email: `${ip}@example.com` } }) as unknown as FastifyRequest;
    it("never let one tenant's attempts use up another's", async () => {
      const limiter = new TenantRateLimiter({
        name: 'test',
        capacity: 10,
        refillPerMs: 10 / 60_000,
        db: factory,
        now: () => 0,
      });
      const ip = fresh();
      const keys = (tenant: TenantScope) => [ipKey(request(tenant, ip)), emailKey(request(tenant, ip))];
      for (let i = 0; i < 10; i += 1) expect(await chargeKeys(limiter, ONE, keys(ONE))).toBe(0);
      expect(await chargeKeys(limiter, ONE, keys(ONE))).toBeGreaterThan(0);
      expect(await chargeKeys(limiter, TWO, keys(TWO))).toBe(0);
    });
  });

  describe('SCIM failed-attempt keys', () => {
    it('give one address two buckets in two tenants: ten failures in one leave the other whole', async () => {
      // The module's limiter: ten failures a minute.
      const limiter = new TenantRateLimiter({
        name: 'test',
        capacity: 10,
        refillPerMs: 10 / 60_000,
        db: factory,
        now: () => 0,
      });
      const from = (tenant: TenantScope) => ({ ip: '203.0.113.7', tenant });
      for (let i = 0; i < 10; i++) expect((await limiter.take(ONE, scimLimiterKey(from(ONE)))).allowed).toBe(true);
      expect((await limiter.take(ONE, scimLimiterKey(from(ONE)))).allowed).toBe(false);
      expect((await limiter.take(TWO, scimLimiterKey(from(TWO)))).allowed).toBe(true);
    });
  });

  describe('the failed-pairing budget', () => {
    it('50 failures in one tenant close its pairing and leave another tenant’s budget untouched', async () => {
      let at = Date.parse('2026-10-31T12:00:00Z');
      const budget = new PairingBudget(factory, () => new Date(at));
      expect(AGENT_RATE_LIMITS.pairFailures.capacity).toBe(50);
      for (let i = 0; i < 50; i++) {
        expect((await budget.open(ONE)).allowed).toBe(true);
        await budget.failed(ONE);
      }
      expect(await budget.open(ONE)).toMatchObject({ allowed: false });
      expect(await budget.open(TWO)).toMatchObject({ allowed: true });
      for (let i = 0; i < 49; i++) await budget.failed(TWO);
      expect((await budget.open(TWO)).allowed).toBe(true);
      // The window refills: ten minutes later tenant 1 may try again.
      at += AGENT_RATE_LIMITS.pairFailures.windowMs;
      expect((await budget.open(ONE)).allowed).toBe(true);
    });
  });

  describe('CatchBuckets (webhook-capture §3.3 step 3)', () => {
    const clock = () => {
      let now = Date.parse('2026-11-04T12:00:00Z');
      return {
        now: (): number => now,
        advance: (ms: number): void => {
          now += ms;
        },
      };
    };
    const takes = async (buckets: CatchBuckets, key: string, n: number): Promise<boolean[]> => {
      const out: boolean[] = [];
      for (let i = 0; i < n; i++) out.push(await buckets.take(ONE, key));
      return out;
    };

    it('allows a full burst at once, then refuses without spending', async () => {
      const c = clock();
      const buckets = new CatchBuckets({ ratePerSecond: 1, burst: 3, db: factory, now: c.now });
      const a = fresh();
      expect(await takes(buckets, a, 3)).toEqual([true, true, true]);
      expect(await takes(buckets, a, 2)).toEqual([false, false]);
      expect(await buckets.take(ONE, fresh())).toBe(true); // one bucket per catch URL
    });

    it('refills at the configured rate, never above the burst', async () => {
      const c = clock();
      const buckets = new CatchBuckets({ ratePerSecond: 10, burst: 2, db: factory, now: c.now });
      const a = fresh();
      expect(await takes(buckets, a, 3)).toEqual([true, true, false]);
      c.advance(99);
      expect(await buckets.take(ONE, a)).toBe(false);
      c.advance(1); // 100 ms at 10/s is one token
      expect(await takes(buckets, a, 2)).toEqual([true, false]);
      c.advance(60_000); // a minute idle refills to the burst, not to 600
      expect(await takes(buckets, a, 3)).toEqual([true, true, false]);
    });

    it('lead with the tenant, so one catch URL id in two tenants never shares a bucket', async () => {
      const hook = fresh();
      const c = clock();
      const buckets = new CatchBuckets({ ratePerSecond: 1, burst: 2, db: factory, now: c.now });
      expect(await takes(buckets, catchBucketKey(ONE.tenantId, hook), 3)).toEqual([true, true, false]);
      expect(await buckets.take(TWO, catchBucketKey(TWO.tenantId, hook))).toBe(true);
    });
  });
});
