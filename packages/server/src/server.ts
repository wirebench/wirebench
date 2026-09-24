/**
 * Builds the Fastify instance every module plugs into (host spec §5.2): the problem error handler
 * (§3.3), the redacting logger (§3.6), `/healthz`, `/api/v1/meta`, then each module under
 * `/api/v1`. Tests build it with a fake database and `modules: []`. Response schemas are plain
 * JSON Schema (via `z.toJSONSchema`, see `schema.ts`) validated by Fastify's own compiler: the
 * dependency check in ADR-0009 found `fastify-type-provider-zod`'s required peers
 * (`@fastify/swagger`, `openapi-types`) would ship in the container image licensed for nothing.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import type { ServerContext, ServerModule } from './context.js';
import { toProblem } from './problem.js';
import { healthRoutes } from './routes/health.js';
import { metaRoutes } from './routes/meta.js';

export interface BuildServerOptions {
  readonly modules: readonly ServerModule[];
}

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.token',
  '*.secret',
  '*.clientSecret',
];

export async function buildServer(ctx: ServerContext, options: BuildServerOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: ctx.config.logLevel, redact: { paths: REDACT_PATHS, censor: '[redacted]' } },
    trustProxy: ctx.config.trustProxy,
    requestIdHeader: ctx.config.trustProxy ? 'x-request-id' : false,
    bodyLimit: ctx.config.bodyLimitMb * 1024 * 1024,
  });

  const context: ServerContext = { ...ctx, log: app.log };

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  app.setNotFoundHandler((request, reply) => {
    void reply.code(404).send({ code: 'not-found', message: `No route for ${request.method} ${request.url}` });
  });

  app.setErrorHandler((error, request, reply) => {
    if ((error as { code?: string }).code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply
        .code(413)
        .send({ code: 'request-too-large', message: `Request bodies are limited to ${ctx.config.bodyLimitMb} MiB.` });
    }
    const mapped = toProblem(error);
    if (mapped.status >= 500) {
      request.log.error({ err: error, requestId: request.id }, 'unhandled error');
    }
    return reply.code(mapped.status).send(mapped.body);
  });

  await app.register(healthRoutes(context));
  await app.register(
    async (api) => {
      await api.register(metaRoutes(context));
      for (const module of options.modules) {
        await api.register(async (scope) => module.register(scope, context));
      }
    },
    { prefix: '/api/v1' },
  );
  await app.ready();
  return app;
}
