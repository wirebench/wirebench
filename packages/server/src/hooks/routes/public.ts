/**
 * `ANY /hooks/:secret[/*]` (webhook-capture spec §3.3), served at the root through `registerPublic`,
 * in a scope of its own: the catch-all byte parser below never reaches `/api/v1`, and identity's
 * `onRequest` hook never runs here. The secret is the only credential.
 *
 * Every answer is one of: the configured response, a bare `404` (unknown and disabled look alike),
 * `413` (Fastify, past the server's general body limit), `429` (the bucket is empty) or `503` (the
 * capture was not stored, so the sender must retry). Nothing from the request is echoed.
 */
import { CATCH_SECRET_PATTERN } from '@wirebench/engine';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { announce } from '../../context.js';
import { headerPairs, splitTarget, subpathOf, truncateBody } from '../capture.js';
import type { HooksEnv } from '../env.js';
import * as repo from '../repo.js';

const EMPTY = Buffer.alloc(0);

/** §3.3 step 5: a webhook sender reads 2xx as delivered, so a capture that was not stored answers 503. */
function unavailable(request: FastifyRequest, reply: FastifyReply, error: unknown): FastifyReply {
  request.log.error({ err: error }, 'could not store a capture');
  return reply.code(503).header('retry-after', '30').send();
}

/** §3.3 step 6: a timer, holding no database connection; the transaction has already released it. */
function delay(env: HooksEnv, ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    env.setTimer(resolve, ms);
  });
}

async function receive(env: HooksEnv, request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  const { secret } = request.params as { readonly secret: string };
  let found: repo.PublicCatchUrl | undefined;
  try {
    found = CATCH_SECRET_PATTERN.test(secret) ? await repo.catchUrlBySecret(env.ctx.db, secret) : undefined;
  } catch (error) {
    return unavailable(request, reply, error);
  }
  // §3.3 step 2: unknown and disabled answer alike, with no body, so a caller cannot tell them apart.
  if (found === undefined || !found.enabled) return reply.code(404).send();
  const hook = found;
  if (!env.buckets.take(hook.id)) return reply.code(429).header('retry-after', '1').send();

  const { path, query } = splitTarget(request.url);
  const capture: repo.NewCapture = {
    id: env.newCaptureId(),
    catchUrlId: hook.id,
    receivedAt: env.now(),
    method: request.method,
    subpath: subpathOf(path),
    query,
    headers: headerPairs(request.raw.rawHeaders),
    ...truncateBody(Buffer.isBuffer(request.body) ? request.body : EMPTY, env.settings.bodyLimitBytes),
    // `request.ip` follows `trustProxy` (§3.3).
    sourceIp: request.ip,
  };
  try {
    await env.ctx.db.transaction(async (tx) => {
      await repo.insertCapture(tx, capture);
      await repo.pruneCaptures(tx, hook.id, env.settings.keep);
    });
  } catch (error) {
    return unavailable(request, reply, error);
  }
  // After commit, on the success path only (§3.6); never awaited, a listener's throw is logged.
  announce(
    env.ctx.hooks.captureReceived,
    { workspaceId: hook.workspaceId, hookId: hook.id, captureId: capture.id },
    request.log,
  );

  await delay(env, hook.response.delayMs);
  void reply.code(hook.response.status);
  if (hook.response.contentType !== null) void reply.header('content-type', hook.response.contentType);
  // A Buffer, not a string: Fastify appends `; charset=utf-8` to a string body's content type
  // whenever it looks like JSON, which would change a configured `application/json` on the wire.
  return hook.response.body === null ? reply.send() : reply.send(Buffer.from(hook.response.body, 'utf-8'));
}

export const publicRoutes =
  (env: HooksEnv) =>
  (root: FastifyInstance): void => {
    // Every content type, and none, is read as raw bytes: a webhook body is stored as it arrived.
    // The route's body limit stays the server's general one, so a larger body still gets 413.
    root.removeAllContentTypeParsers();
    root.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => {
      done(null, body);
    });
    const handler = (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> =>
      receive(env, request, reply);
    // find-my-way does not match `/hooks/<secret>` against the wildcard route, hence two.
    root.all('/hooks/:secret', handler);
    root.all('/hooks/:secret/*', handler);
  };
