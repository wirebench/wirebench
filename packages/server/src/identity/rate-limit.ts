/**
 * In-process token buckets for the unauthenticated endpoints that take a secret (spec §3.6): 10
 * attempts per minute, per client IP and per email, reset on restart. No dependency, no shared
 * state across instances (the one-instance assumption, ADR-0009).
 */

export interface RateLimiterOptions {
  /** Attempts a bucket can hold before it refuses. */
  readonly capacity: number;
  /** How fast a bucket refills, in tokens per millisecond. */
  readonly refillPerMs: number;
  /** Injected clock, so tests can move time without waiting on it. */
  readonly now: () => number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/** Whether an attempt is allowed, and — when it is not — how long until the next one might be. */
export interface RateLimitResult {
  readonly allowed: boolean;
  readonly retryAfterMs: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly now: () => number;

  constructor(options: RateLimiterOptions) {
    this.capacity = options.capacity;
    this.refillPerMs = options.refillPerMs;
    this.now = options.now;
  }

  /** Consumes one token from `key`'s bucket, refilling it for the time elapsed since it was last touched. */
  take(key: string): RateLimitResult {
    const now = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, updatedAt: now };
    const elapsed = Math.max(0, now - bucket.updatedAt);
    const refilled = Math.min(this.capacity, bucket.tokens + elapsed * this.refillPerMs);
    if (refilled < 1) {
      this.buckets.set(key, { tokens: refilled, updatedAt: now });
      const missing = 1 - refilled;
      return { allowed: false, retryAfterMs: Math.ceil(missing / this.refillPerMs) };
    }
    this.buckets.set(key, { tokens: refilled - 1, updatedAt: now });
    return { allowed: true, retryAfterMs: 0 };
  }
}

/** The bucket key for a client IP: `trustProxy` decides whether that IP came from a header. */
export function ipKey(ip: string): string {
  return `ip:${ip}`;
}

/** The bucket key for an email; lower-cased, matching `email_lower` everywhere else. */
export function emailKey(email: string): string {
  return `email:${email.toLowerCase()}`;
}

/** Checks both the IP and the email buckets for one attempt; refused if either is exhausted. */
export function rateLimit(limiter: RateLimiter, ip: string, email: string): RateLimitResult {
  const byIp = limiter.take(ipKey(ip));
  const byEmail = limiter.take(emailKey(email));
  if (!byIp.allowed || !byEmail.allowed) {
    return { allowed: false, retryAfterMs: Math.max(byIp.retryAfterMs, byEmail.retryAfterMs) };
  }
  return { allowed: true, retryAfterMs: 0 };
}
