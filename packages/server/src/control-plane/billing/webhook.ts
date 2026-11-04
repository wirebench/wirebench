/**
 * The billing webhook (hosted edition spec §22.5, §22.16, ADR-0039): `POST /billing/paddle` on the entry host
 * (`ENTRY_ROUTE`, so no tenant resolves), hosted mode only. The body is read raw, at most 1 MiB, and never parsed
 * before its signature passes. It answers:
 *
 * - `401`, empty, when the signature fails; the log holds the reason code, never the header or the body;
 * - `429`, empty, with `retry-after`, past {@link WEBHOOK_RATE} posts a minute from one client address, checked before
 *   the signature so a flood costs no HMAC; Paddle retries a `429` like any other failure;
 * - `200` once the event is applied, recorded, a duplicate, or not one it applies;
 * - `500` on a database failure, so Paddle retries;
 *
 * and never another status of its own.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { RateLimiter } from '../../identity/rate-limit.js';
import { ENTRY_ROUTE } from '../../tenancy/resolve.js';
import type { BillingOutcome, MappedEvent } from './events.js';
import { mapPaddleEvent } from './paddle.js';
import { verifyPaddleSignature } from './signature.js';

export const PADDLE_WEBHOOK_PATH = '/billing/paddle';

/** Paddle's events are a few kilobytes; a megabyte is far past any. */
export const WEBHOOK_BODY_LIMIT = 1024 * 1024;

/** Posts a minute per client address: far above Paddle's own rate from its few sending addresses. */
export const WEBHOOK_RATE = 300;

export interface PaddleWebhookOptions {
  /** The notification destination's secret key. */
  readonly secret: string;
  readonly teamPriceId: string;
  readonly apply: (mapped: MappedEvent) => Promise<BillingOutcome>;
  readonly now?: () => number;
}

/** The per-address limit as a preHandler, so it runs before the body is hashed. */
function rateLimitByAddress(clients: RateLimiter): preHandlerHookHandler {
  return (request: FastifyRequest, reply: FastifyReply, done: (error?: Error) => void): void => {
    const client = clients.take(`ip:${request.ip}`);
    if (client.allowed) {
      done();
      return;
    }
    void reply
      .code(429)
      .header('cache-control', 'no-store')
      .header('retry-after', String(client.retryAfterSeconds))
      .send();
  };
}

function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'unknown';
}

export function registerPaddleWebhook(app: FastifyInstance, options: PaddleWebhookOptions): void {
  const now = options.now ?? Date.now;
  const clients = new RateLimiter({ capacity: WEBHOOK_RATE, refillPerMs: WEBHOOK_RATE / 60_000, now });
  // Its own scope, so the raw parser and its limit reach no other route.
  void app.register((scope, _options, registered) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: WEBHOOK_BODY_LIMIT }, (_request, body, done) => {
      done(null, body);
    });
    const route = { ...ENTRY_ROUTE, bodyLimit: WEBHOOK_BODY_LIMIT, preHandler: [rateLimitByAddress(clients)] };
    scope.post(PADDLE_WEBHOOK_PATH, route, async (request, reply) => {
      void reply.header('cache-control', 'no-store');
      const log = request.log;
      const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
      const check = verifyPaddleSignature(request.headers['paddle-signature'], body, options.secret, now());
      if (!check.ok) {
        log.warn({ reason: check.reason }, 'a billing webhook was refused');
        return reply.code(401).send();
      }
      let mapped: MappedEvent;
      try {
        mapped = mapPaddleEvent(body, options.teamPriceId);
      } catch (error) {
        // Signed, so Paddle's, but not an event: a retry would send the same bytes.
        log.warn({ reason: codeOf(error) }, 'a signed billing webhook is not an event');
        return reply.code(200).send();
      }
      try {
        await options.apply(mapped);
        return await reply.code(200).send();
      } catch (error) {
        // The code only: a database error's text can quote the values it was given.
        log.error({ reason: codeOf(error), eventId: mapped.event.eventId }, 'a billing event could not be applied');
        return reply.code(500).send();
      }
    });
    registered();
  });
}
