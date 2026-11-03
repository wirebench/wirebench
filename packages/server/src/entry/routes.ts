/**
 * The entry's two routes (hosted edition spec §21.4), on `app.<app-domain>` only (`ENTRY_ROUTE`). `GET /` is the
 * page; `POST /` queues a lookup and answers the same page for every input: known, unknown, malformed or over a rate
 * limit. Nothing sets a cookie and nothing signs anyone in.
 */
import { createHmac, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { RateLimiter } from '../identity/rate-limit.js';
import { ENTRY_ROUTE } from '../tenancy/resolve.js';
import { ENTRY_PAGE_CSP, renderEntryPage } from './page.js';
import type { EntryQueue } from './queue.js';

/** A form with one address field never needs more. */
export const ENTRY_BODY_LIMIT = 1024;

/** 5 a minute per client address, 3 an hour per email address (spec §21.4). */
export const PER_CLIENT = { capacity: 5, refillPerMs: 5 / 60_000 } as const;
export const PER_ADDRESS = { capacity: 3, refillPerMs: 3 / 3_600_000 } as const;

/** What `<input type=email>` accepts, near enough: one `@`, a dot in the domain, no space, at most 254 characters. */
const ADDRESS = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]+$/;

/** The per-address bucket's key: a keyed hash, so the limiter's map never holds an address. */
export function addressBucketKey(key: Buffer, address: string): string {
  return createHmac('sha256', key).update(address).digest('base64url');
}

export interface EntryRoutesOptions {
  readonly entryHost: string;
  readonly siteUrl: string;
  readonly queue: Pick<EntryQueue, 'push'>;
  readonly now?: () => number;
}

export function registerEntryRoutes(app: FastifyInstance, options: EntryRoutesOptions): void {
  const origin = `https://${options.entryHost}`;
  const clients = new RateLimiter({ ...PER_CLIENT, ...(options.now !== undefined ? { now: options.now } : {}) });
  const addresses = new RateLimiter({ ...PER_ADDRESS, ...(options.now !== undefined ? { now: options.now } : {}) });
  // A key that lives as long as the process, so the per-address buckets never hold an address in the clear.
  const bucketKey = randomBytes(32);
  const keyOf = (address: string): string => addressBucketKey(bucketKey, address);

  const page = (reply: FastifyReply, answered: boolean): FastifyReply =>
    reply
      .code(200)
      .header('content-security-policy', ENTRY_PAGE_CSP)
      .header('referrer-policy', 'same-origin')
      .header('cache-control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(renderEntryPage({ siteUrl: options.siteUrl, answered }));

  app.get('/', ENTRY_ROUTE, (_request, reply) => page(reply, false));

  // Its own scope, so the form parser and its body limit reach nothing else.
  void app.register((form, _options, registered) => {
    form.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string', bodyLimit: ENTRY_BODY_LIMIT },
      (_request, body, done) => {
        done(null, new URLSearchParams(body as string));
      },
    );
    form.post('/', { ...ENTRY_ROUTE, bodyLimit: ENTRY_BODY_LIMIT }, (request, reply) => {
      // Another site's form must not make a visitor's browser mail someone.
      if (request.headers.origin !== origin) return reply.code(403).header('cache-control', 'no-store').send();
      const body = request.body instanceof URLSearchParams ? request.body : new URLSearchParams();
      const address = (body.get('email') ?? '').trim().toLowerCase();
      // Both buckets are charged for every post, so a refused one tells a prober nothing about the address either.
      const client = clients.take(`ip:${request.ip}`);
      if (client.allowed && address.length <= 254 && ADDRESS.test(address)) {
        if (addresses.take(keyOf(address)).allowed) options.queue.push(address);
      }
      return page(reply, true);
    });
    registered();
  });
}
