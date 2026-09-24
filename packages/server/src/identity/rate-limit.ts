/**
 * In-process token buckets (identity spec §3.6): 10 attempts a minute per key, refilled
 * continuously. State is per process by design — ADR-0009 runs one replica — and resets on
 * restart. The map is pruned of full buckets when it grows, so an address scan cannot make it
 * grow without bound.
 */
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { IdentityEnv } from './env.js';

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Whole seconds until one attempt is available again; `0` when allowed. */
  readonly retryAfterSeconds: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

const PRUNE_ABOVE = 10_000;

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly now: () => number;

  constructor(options: { readonly capacity: number; readonly refillPerMs: number; readonly now?: () => number }) {
    this.capacity = options.capacity;
    this.refillPerMs = options.refillPerMs;
    this.now = options.now ?? (() => Date.now());
  }

  take(key: string): RateLimitDecision {
    const now = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, updatedAt: now };
    const tokens = Math.min(this.capacity, bucket.tokens + Math.max(0, now - bucket.updatedAt) * this.refillPerMs);
    if (tokens >= 1) {
      this.buckets.set(key, { tokens: tokens - 1, updatedAt: now });
      this.prune();
      return { allowed: true, retryAfterSeconds: 0 };
    }
    this.buckets.set(key, { tokens, updatedAt: now });
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((1 - tokens) / this.refillPerMs / 1000)) };
  }

  private prune(): void {
    if (this.buckets.size <= PRUNE_ABOVE) return;
    const now = this.now();
    for (const [key, bucket] of this.buckets) {
      if (bucket.tokens + (now - bucket.updatedAt) * this.refillPerMs >= this.capacity) this.buckets.delete(key);
    }
  }
}

/**
 * A preHandler that charges every key `keysOf` returns and answers 429 with `Retry-After` when
 * any is empty. Sent directly rather than thrown: the host's error handler sets no headers.
 */
export function rateLimit(
  env: IdentityEnv,
  keysOf: (request: FastifyRequest) => readonly (string | undefined)[],
): preHandlerHookHandler {
  return (request: FastifyRequest, reply: FastifyReply, done: (error?: Error) => void): void => {
    let retryAfter = 0;
    for (const key of keysOf(request)) {
      if (key === undefined) continue;
      const decision = env.limiter.take(key);
      if (!decision.allowed) retryAfter = Math.max(retryAfter, decision.retryAfterSeconds);
    }
    if (retryAfter > 0) {
      void reply
        .header('retry-after', String(retryAfter))
        .code(429)
        .send({ code: 'identity-rate-limited', message: 'Too many attempts. Try again shortly.' });
      return;
    }
    done();
  };
}

/** The per-IP key; `request.ip` already honours `trustProxy`. */
export const ipKey = (request: FastifyRequest): string => `ip:${request.ip}`;
/** The per-email key of a body that carries one, lower-cased so case cannot dodge the bucket. */
export const emailKey = (request: FastifyRequest): string | undefined => {
  const email = (request.body as { readonly email?: unknown } | undefined)?.email;
  return typeof email === 'string' ? `email:${email.trim().toLowerCase()}` : undefined;
};
