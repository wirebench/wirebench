/**
 * The shared limiter (hosted edition spec §20.7, amending ADR-0009's "shared rate-limit store"): token buckets in
 * `limiter_buckets`, an unlogged scoped table keyed `(tenant_id, key)`, so every instance charges the same bucket and
 * one tenant's attacker gets no more attempts from several instances than from one. After a crash the table is
 * empty and every bucket starts full, as an in-memory limiter did after a restart.
 *
 * A charge is one statement in the tenant's unit: refill by the time since the bucket's last spend, take `cost` if
 * there is that much, and answer what is left. A refusal changes nothing, so the bucket keeps refilling from its last
 * spend. The clock is the database's (`statement_timestamp()`), the one clock every instance shares; `at` replaces it
 * for a test's injected clock only.
 */
import type { TenantQuerier } from '../tenancy/tenant-db.js';

export interface BucketSize {
  /** Tokens a full bucket holds. */
  readonly capacity: number;
  /** Tokens added per millisecond, up to `capacity`. */
  readonly refillPerMs: number;
}

export interface ChargeOptions extends BucketSize {
  /** Tokens this charge takes; at most `capacity`. */
  readonly cost: number;
  /** Test only: the moment of the charge, for a module built with an injected clock. The database's otherwise. */
  readonly at?: Date;
}

export interface Charge {
  readonly ok: boolean;
  /** Tokens left after the charge, or held when it was refused. */
  readonly tokens: number;
  /** Milliseconds until `cost` tokens are there again; `0` when the charge was taken. */
  readonly retryAfterMs: number;
}

const AT = 'coalesce($5::timestamptz, statement_timestamp())';
/** A bucket's tokens at `at`, from its row `b`: refilled by the milliseconds since its last spend. */
const refilled = (at: string): string =>
  `least($2::float8, b.tokens + greatest(0, extract(epoch from (${at} - b.updated_at))::float8 * 1000) * $3::float8)`;

/**
 * `$1` key, `$2` capacity, `$3` refill per ms, `$4` cost, `$5` the test clock or null. The upsert's update runs only
 * when the refilled bucket holds `cost`, so `charged` is a row exactly when the charge was taken. When it is not,
 * `held` reads the bucket from the statement's snapshot, for the retry time.
 */
const CHARGE = `with charged as (
  insert into limiter_buckets as b (key, tokens, updated_at)
  values ($1, $2::float8 - $4::float8, ${AT})
  on conflict (tenant_id, key) do update
    set tokens = ${refilled('excluded.updated_at')} - $4::float8, updated_at = excluded.updated_at
    where ${refilled('excluded.updated_at')} >= $4::float8
  returning b.tokens
)
select (select tokens from charged) as charged,
       (select ${refilled(AT)} from limiter_buckets b where b.key = $1) as held`;

/** `$1` key, `$2` capacity, `$3` refill per ms, `$4` the test clock or null. */
const PEEK = `select ${refilled('coalesce($4::timestamptz, statement_timestamp())')} as tokens
  from limiter_buckets b where b.key = $1`;

const retryAfter = (tokens: number, options: ChargeOptions): number =>
  Math.max(1, Math.ceil((options.cost - tokens) / options.refillPerMs));

function paramsOf(key: string, options: ChargeOptions): unknown[] {
  if (!(options.cost > 0 && options.cost <= options.capacity))
    throw new RangeError(`a charge of ${String(options.cost)} does not fit a bucket of ${String(options.capacity)}`);
  return [key, options.capacity, options.refillPerMs, options.cost, options.at ?? null];
}

/** Takes `cost` tokens from `key`'s bucket in `tx`'s tenant, or refuses with the time until it could. */
export async function charge(tx: TenantQuerier, key: string, options: ChargeOptions): Promise<Charge> {
  const { rows } = await tx.query<{ charged: number | null; held: number | null }>(CHARGE, paramsOf(key, options));
  const row = rows[0]!;
  if (row.charged !== null) return { ok: true, tokens: row.charged, retryAfterMs: 0 };
  // `held` is null only when another unit made the bucket after this statement's snapshot and spent it.
  const tokens = row.held ?? 0;
  return { ok: false, tokens, retryAfterMs: retryAfter(tokens, options) };
}

/**
 * Whether `key`'s bucket holds `cost` tokens, without taking them: for a bucket charged only on a failure, checked
 * before the attempt. A bucket with no row is full.
 */
export async function peek(tx: TenantQuerier, key: string, options: ChargeOptions): Promise<Charge> {
  const [, capacity, refillPerMs, , at] = paramsOf(key, options);
  const { rows } = await tx.query<{ tokens: number }>(PEEK, [key, capacity, refillPerMs, at]);
  const tokens = rows[0]?.tokens ?? options.capacity;
  if (tokens >= options.cost) return { ok: true, tokens, retryAfterMs: 0 };
  return { ok: false, tokens, retryAfterMs: retryAfter(tokens, options) };
}
