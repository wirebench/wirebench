/**
 * One token bucket per catch URL (webhook-capture spec §3.3 step 3): `ratePerSecond` tokens a second, up to
 * `burst`. The buckets live in the shared limiter's table (hosted edition spec §20.7), so every instance spends the
 * same one; a bucket with no row is full.
 */
import { charge, registerBucket } from '../operations/limiter.js';
import type { TenantScope } from '../tenancy/scope.js';
import { outsideTenantUnit, type TenantDbFactory } from '../tenancy/tenant-db.js';

/**
 * A catch URL's bucket key, led by its tenant (hosted edition spec §19.8 guard 5): catch URL ids are per tenant
 * from `0021`, so one id in two tenants is two buckets.
 */
export function catchBucketKey(tenantId: string, hookId: string): string {
  return `${tenantId}:${hookId}`;
}

export class CatchBuckets {
  private readonly perMs: number;
  private readonly burst: number;
  private readonly db: TenantDbFactory;
  private readonly now: (() => number) | undefined;

  constructor(options: {
    readonly ratePerSecond: number;
    readonly burst: number;
    readonly db: TenantDbFactory;
    /** A test's injected clock; the database's clock otherwise. */
    readonly now?: (() => number) | undefined;
  }) {
    this.perMs = options.ratePerSecond / 1000;
    this.burst = options.burst;
    this.db = options.db;
    this.now = options.now;
    registerBucket({ capacity: this.burst, refillPerMs: this.perMs });
  }

  /**
   * Spends one token of `key`'s bucket in `scope`. `false` when it is empty; nothing is spent then. A unit of its
   * own, so a capture that fails afterwards does not give the token back. Its rows are `catch/<key>`, apart
   * from every other limiter's.
   */
  async take(scope: TenantScope, key: string): Promise<boolean> {
    const at = this.now === undefined ? {} : { at: new Date(this.now()) };
    const result = await outsideTenantUnit(() =>
      charge(this.db(scope), `catch/${key}`, { capacity: this.burst, refillPerMs: this.perMs, cost: 1, ...at }),
    );
    return result.ok;
  }
}
