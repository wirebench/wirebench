import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context.js';
import { jsonSchema } from '../schema.js';

export const metaResponseSchema = z.object({
  name: z.literal('wirebench-server'),
  version: z.string(),
  apiVersion: z.literal(1),
  publicUrl: z.string().url(),
  auth: z.object({ local: z.boolean(), oidc: z.boolean(), oidcDisplayName: z.string().optional() }),
  capabilities: z.array(z.string()),
});

export const metaRoutes =
  (ctx: ServerContext) =>
  (app: FastifyInstance): void => {
    app.get('/meta', { schema: { response: { 200: jsonSchema(metaResponseSchema) } } }, () => ({
      name: 'wirebench-server',
      version: ctx.config.version,
      apiVersion: 1,
      publicUrl: ctx.config.publicUrl,
      auth: ctx.meta.signInMethods(),
      capabilities: ctx.meta.capabilities(),
    }));
  };
