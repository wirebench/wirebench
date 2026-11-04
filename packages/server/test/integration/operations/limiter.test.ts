/**
 * Slice 5 Task 8 (hosted edition spec §20.7): the shared limiter. Two tenant databases on separate pools stand for
 * two instances: they spend one bucket. The refill matches the in-memory limiter's step for step, two tenants with
 * one key have two buckets, the database's clock refills a bucket when no test clock is given, and a peek spends
 * nothing.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Database } from '../../../src/db/querier.js';
import { createDatabase } from '../../../src/db/pool.js';
import { RateLimiter } from '../../../src/identity/rate-limit.js';
import { charge, peek } from '../../../src/operations/limiter.js';
import { TenantDirectory } from '../../../src/tenancy/directory.js';
import { scopeOf, type TenantScope } from '../../../src/tenancy/scope.js';
import { tenantDbFactory, type TenantDb } from '../../../src/tenancy/tenant-db.js';
import { describeDb, testDatabase, type TestDatabase } from '../../helpers/database.js';

const SIGN_IN = { capacity: 10, refillPerMs: 10 / 60_000, cost: 1 } as const;
const T0 = Date.parse('2026-11-04T12:00:00.000Z');
const at = (ms: number): Date => new Date(T0 + ms);

describeDb('the shared limiter (hosted spec §20.7)', () => {
  let db: TestDatabase;
  let second: Database;
  let scope: TenantScope;
  let other: TenantScope;
  /** The two instances' views of the default tenant, and the first one's of another tenant. */
  let a: TenantDb;
  let b: TenantDb;
  let aOther: TenantDb;

  beforeAll(async () => {
    db = await testDatabase();
    const directory = new TenantDirectory(db);
    await directory.load();
    scope = directory.defaultScope();
    const otherId = randomUUID();
    await db.owner.query('insert into tenants (id, slug, name) values ($1, $2, $3)', [otherId, 'globex', 'Globex']);
    other = scopeOf({ id: otherId, slug: 'globex' });
    second = createDatabase(db.url);
    a = tenantDbFactory(db)(scope);
    aOther = tenantDbFactory(db)(other);
    b = tenantDbFactory(second)(scope);
  });
  afterAll(async () => {
    await second?.close();
    await db?.close();
  });

  it('two instances spend one bucket', async () => {
    const key = `${scope.tenantId}:ip:10.0.0.1`;
    for (let n = 0; n < 6; n++) expect((await charge(a, key, { ...SIGN_IN, at: at(0) })).ok).toBe(true);
    for (let n = 0; n < 4; n++) expect((await charge(b, key, { ...SIGN_IN, at: at(0) })).ok).toBe(true);
    const refusedA = await charge(a, key, { ...SIGN_IN, at: at(0) });
    const refusedB = await charge(b, key, { ...SIGN_IN, at: at(0) });
    expect(refusedA).toEqual({ ok: false, tokens: 0, retryAfterMs: 6000 });
    expect(refusedB).toEqual({ ok: false, tokens: 0, retryAfterMs: 6000 });
  });

  it('charged at once from both instances, the bucket hands out exactly its capacity', async () => {
    const key = `${scope.tenantId}:ip:10.0.0.2`;
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, n) => charge(n % 2 === 0 ? a : b, key, { ...SIGN_IN, at: at(0) })),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(10);
  });

  it('refills as the in-memory limiter did, step for step', async () => {
    const key = `${scope.tenantId}:email:refill@example.com`;
    let clock = 0;
    const memory = new RateLimiter({ capacity: SIGN_IN.capacity, refillPerMs: SIGN_IN.refillPerMs, now: () => clock });
    // Advances in ms, each followed by one attempt: a burst, short gaps, a refusal streak, and a long idle.
    const steps = [
      ...Array<number>(12).fill(0),
      5_999,
      1,
      0,
      3_000,
      3_000,
      0,
      500,
      12_000,
      0,
      0,
      0,
      120_000,
      ...Array<number>(11).fill(0),
    ];
    for (const step of steps) {
      clock += step;
      const before = memory.take(key);
      const after = await charge(b, key, { ...SIGN_IN, at: at(clock) });
      const seconds = after.ok ? 0 : Math.max(1, Math.ceil(after.retryAfterMs / 1000));
      expect({ allowed: after.ok, retryAfterSeconds: seconds }, `at ${String(clock)} ms`).toEqual(before);
    }
  });

  it('keeps two tenants’ buckets with one key apart', async () => {
    const key = 'same-key';
    for (let n = 0; n < 10; n++) await charge(a, key, { ...SIGN_IN, at: at(0) });
    expect((await charge(a, key, { ...SIGN_IN, at: at(0) })).ok).toBe(false);
    expect(await charge(aOther, key, { ...SIGN_IN, at: at(0) })).toEqual({ ok: true, tokens: 9, retryAfterMs: 0 });
    const rows = await db.owner.transaction(async (tx) => {
      await tx.query("select set_config('wirebench.tenant_id', $1, true)", [other.tenantId]);
      return (await tx.query<{ tokens: number }>('select tokens from limiter_buckets where key = $1', [key])).rows;
    });
    expect(rows).toEqual([{ tokens: 9 }]);
  });

  it('refills by the database’s clock when no test clock is given', async () => {
    const key = `${scope.tenantId}:ip:10.0.0.3`;
    for (let n = 0; n < 10; n++) expect((await charge(a, key, SIGN_IN)).ok).toBe(true);
    const refused = await charge(b, key, SIGN_IN);
    expect(refused.ok).toBe(false);
    expect(refused.retryAfterMs).toBeGreaterThan(5_000);
    expect(refused.retryAfterMs).toBeLessThanOrEqual(6_000);
    // Six seconds back on the bucket's last spend is one token at ten a minute.
    await a.query("update limiter_buckets set updated_at = updated_at - interval '6 seconds' where key = $1", [key]);
    expect((await charge(b, key, SIGN_IN)).ok).toBe(true);
    expect((await charge(b, key, SIGN_IN)).ok).toBe(false);
  });

  it('peeks without spending, and reads an unknown bucket as full', async () => {
    const key = `${scope.tenantId}:pairings`;
    const budget = { capacity: 2, refillPerMs: 2 / 600_000, cost: 1 } as const;
    expect(await peek(a, key, { ...budget, at: at(0) })).toEqual({ ok: true, tokens: 2, retryAfterMs: 0 });
    await charge(a, key, { ...budget, at: at(0) });
    await charge(b, key, { ...budget, at: at(0) });
    for (let n = 0; n < 3; n++) expect((await peek(b, key, { ...budget, at: at(0) })).ok).toBe(false);
    expect(await peek(a, key, { ...budget, at: at(0) })).toEqual({ ok: false, tokens: 0, retryAfterMs: 300_000 });
    expect((await peek(a, key, { ...budget, at: at(300_000) })).ok).toBe(true);
  });

  it('refuses a charge larger than the bucket', async () => {
    await expect(charge(a, 'k', { ...SIGN_IN, cost: 11 })).rejects.toThrow(RangeError);
  });
});
