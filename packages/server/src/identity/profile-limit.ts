/**
 * The per-user profile limiter (user profile spec §9, ruling 12): 30 changes a minute (`PATCH /me`, removing an
 * image) and 20 uploads an hour, per person. Two buckets of the one `profile` limiter, keyed by the caller.
 */
import type { preHandlerHookHandler } from 'fastify';
import type { TenantDbFactory } from '../tenancy/tenant-db.js';
import { callerKey, rateLimit, TenantRateLimiter } from './rate-limit.js';

export type ProfileBucket = 'changes' | 'uploads';
export type ProfileLimiters = Readonly<Record<ProfileBucket, TenantRateLimiter>>;

const PROBLEM = {
  code: 'identity-profile-rate-limited',
  message: 'Too many profile changes. Try again shortly.',
} as const;

export function profileLimiters(db: TenantDbFactory, now?: () => number): ProfileLimiters {
  const clock = now !== undefined ? { now } : {};
  return {
    changes: new TenantRateLimiter({ name: 'profile', capacity: 30, refillPerMs: 30 / 60_000, db, ...clock }),
    uploads: new TenantRateLimiter({ name: 'profile', capacity: 20, refillPerMs: 20 / 3_600_000, db, ...clock }),
  };
}

/** Charges the caller's `bucket`; after `requireUser`, so a caller is known. */
export function profileLimit(
  env: { readonly profileLimiters: ProfileLimiters },
  bucket: ProfileBucket,
): preHandlerHookHandler {
  return rateLimit(
    { limiter: env.profileLimiters[bucket] },
    (request) => {
      const key = callerKey(request);
      return [key === undefined ? undefined : `${bucket}:${key}`];
    },
    PROBLEM,
  );
}
