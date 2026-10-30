/**
 * In-process token buckets (identity spec §3.6): 10 attempts a minute per key, refilled
 * continuously. State is per process by design — ADR-0009 runs one replica — and resets on
 * restart. The map is pruned of full buckets when it grows, so an address scan cannot make it
 * grow without bound.
 */
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';

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

  /**
   * Whether `key` has an attempt left, without taking one: for a bucket charged only on failure (the
   * agent module's server-wide failed-pairing limit), checked before the attempt is made.
   */
  peek(key: string): RateLimitDecision {
    const now = this.now();
    const bucket = this.buckets.get(key);
    if (bucket === undefined) return { allowed: true, retryAfterSeconds: 0 };
    const tokens = Math.min(this.capacity, bucket.tokens + Math.max(0, now - bucket.updatedAt) * this.refillPerMs);
    if (tokens >= 1) return { allowed: true, retryAfterSeconds: 0 };
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

const DEFAULT_PROBLEM = { code: 'identity-rate-limited', message: 'Too many attempts. Try again shortly.' } as const;

/**
 * A preHandler that charges every key `keysOf` returns and answers 429 with `Retry-After` when
 * any is empty. Sent directly rather than thrown: the host's error handler sets no headers.
 * `env` is typed structurally (just the limiter) so any module holding a {@link RateLimiter} can
 * reuse this preHandler, not only identity's own routes. `problem` overrides the body for a caller
 * whose bucket means something other than "an identity attempt" (a code and message of its own).
 */
export function rateLimit(
  env: { readonly limiter: RateLimiter },
  keysOf: (request: FastifyRequest) => readonly (string | undefined)[],
  problem: { readonly code: string; readonly message: string } = DEFAULT_PROBLEM,
): preHandlerHookHandler {
  return (request: FastifyRequest, reply: FastifyReply, done: (error?: Error) => void): void => {
    const retryAfter = chargeKeys(env.limiter, keysOf(request));
    if (retryAfter > 0) {
      void reply.header('retry-after', String(retryAfter)).code(429).send(problem);
      return;
    }
    done();
  };
}

/**
 * Charges every key and answers the seconds until the emptiest bucket has an attempt again, or `0`
 * when all of them had one. For a route that answers a refusal its own way (the browser's form).
 */
export function chargeKeys(limiter: RateLimiter, keys: readonly (string | undefined)[]): number {
  let retryAfter = 0;
  for (const key of keys) {
    if (key === undefined) continue;
    const decision = limiter.take(key);
    if (!decision.allowed) retryAfter = Math.max(retryAfter, decision.retryAfterSeconds);
  }
  return retryAfter;
}

/**
 * Every key leads with the request's tenant (hosted edition spec §19.8 guard 5), so one tenant's attempts
 * never use up another's: an address behind one proxy, or one email, can reach several tenants.
 */
type KeyedRequest = Pick<FastifyRequest, 'tenant' | 'ip' | 'body' | 'caller'>;

/** The per-IP key; `request.ip` already honours `trustProxy`. */
export const ipKey = (request: KeyedRequest): string => `${request.tenant.tenantId}:ip:${request.ip}`;
/** The per-email key of a body that carries one, lower-cased so case cannot dodge the bucket. */
export const emailKey = (request: KeyedRequest): string | undefined => {
  const email = (request.body as { readonly email?: unknown } | undefined)?.email;
  return typeof email === 'string' ? `${request.tenant.tenantId}:email:${email.trim().toLowerCase()}` : undefined;
};
/** The per-caller key of an authenticated request; `undefined` before identity's guard has run. */
export const callerKey = (request: KeyedRequest): string | undefined =>
  request.caller === undefined ? undefined : `${request.tenant.tenantId}:user:${request.caller.id}`;
