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
  /** Where log lines go instead of stdout; tests pass a stream to read what was logged. */
  readonly logStream?: NodeJS.WritableStream;
}

/**
 * Pino redaction has no any-depth wildcard: each key is listed bare (a top-level field such as
 * `log.info({ password })`) and as `*.key` (one level down). Deeper nesting is not covered; log
 * credentials at neither depth.
 */
const SECRET_KEYS = ['password', 'token', 'secret', 'clientSecret'] as const;
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  ...SECRET_KEYS,
  ...SECRET_KEYS.map((key) => `*.${key}`),
];

/** The request path without its query string: `?secret=` and `?token=` values must never be logged or echoed. */
function pathOf(url: string): string {
  const query = url.indexOf('?');
  return query === -1 ? url : url.slice(0, query);
}

/** Symbol Fastify reads to register a plugin into its parent's scope instead of a child one. */
const SKIP_OVERRIDE = Symbol.for('skip-override');

export async function buildServer(ctx: ServerContext, options: BuildServerOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: ctx.config.logLevel,
      redact: { paths: REDACT_PATHS, censor: '[redacted]' },
      // Fastify's default request serializer logs the full URL (query string included) and the
      // remote address; only the method, the bare path and the request id are logged.
      serializers: {
        req: (request: { readonly method: string; readonly url: string; readonly id: string }) => ({
          method: request.method,
          url: pathOf(request.url),
          requestId: request.id,
        }),
      },
      ...(options.logStream !== undefined ? { stream: options.logStream } : {}),
    },
    trustProxy: ctx.config.trustProxy,
    requestIdHeader: ctx.config.trustProxy ? 'x-request-id' : false,
    bodyLimit: ctx.config.bodyLimitMb * 1024 * 1024,
  });

  const context: ServerContext = { ...ctx, log: app.log };

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  app.setNotFoundHandler((request, reply) => {
    void reply.code(404).send({ code: 'not-found', message: `No route for ${request.method} ${pathOf(request.url)}` });
  });

  app.setErrorHandler((error, request, reply) => {
    const fastifyError = error as {
      readonly code?: string;
      readonly statusCode?: number;
      readonly validation?: readonly {
        readonly instancePath: string;
        readonly message?: string;
        readonly params?: { readonly missingProperty?: string };
      }[];
    };
    if (fastifyError.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply
        .code(413)
        .send({ code: 'request-too-large', message: `Request bodies are limited to ${ctx.config.bodyLimitMb} MiB.` });
    }
    // Fastify's own schema validation (FST_ERR_VALIDATION) attaches `validation`, the raw Ajv
    // errors; map it to the same { code, message, issues } shape toProblem gives a zod error, so
    // clients never see two different invalid-request shapes.
    if (fastifyError.validation !== undefined) {
      return reply.code(400).send({
        code: 'invalid-request',
        message: 'The request did not match the expected shape.',
        issues: fastifyError.validation.map((issue) => ({
          // Ajv's "required" errors point `instancePath` at the parent, not the missing field
          // itself, and carry the field name in `params.missingProperty` instead.
          path:
            issue.instancePath === '' && issue.params?.missingProperty !== undefined
              ? issue.params.missingProperty
              : issue.instancePath.replace(/^\//, '').split('/').join('.'),
          message: issue.message ?? 'is invalid',
        })),
      });
    }
    // Every other Fastify-raised client error (malformed JSON, wrong content type, and so on)
    // carries its own `statusCode` but a message that can describe internals (header syntax,
    // parser detail); per host spec §3.3 the client only ever sees { code, message }, so the
    // status is kept and the text is replaced with a fixed, generic problem.
    if (
      typeof fastifyError.statusCode === 'number' &&
      fastifyError.statusCode >= 400 &&
      fastifyError.statusCode < 500
    ) {
      return reply
        .code(fastifyError.statusCode)
        .send({ code: 'bad-request', message: 'The request could not be processed.' });
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
        // Registered straight into the /api/v1 scope rather than a child of it (the flag is what
        // fastify-plugin sets): a hook or decorator one module adds, such as identity's
        // `request.caller`, must reach the routes of every module registered after it. /healthz
        // sits outside /api/v1 and never sees them.
        const mount = (scope: FastifyInstance): Promise<void> => module.register(scope, context);
        Object.assign(mount, { [SKIP_OVERRIDE]: true, [Symbol.for('fastify.display-name')]: module.name });
        await api.register(mount);
      }
    },
    { prefix: '/api/v1' },
  );
  for (const module of options.modules) {
    if (module.registerPublic !== undefined) {
      await app.register(async (root) => {
        await module.registerPublic!(root, context);
      });
    }
  }
  await app.ready();
  return app;
}
