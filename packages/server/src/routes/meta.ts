import { metaResponseSchema, SERVER_API_VERSION, SERVER_NAME } from '@wirebench/engine';
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context.js';
import { jsonSchema } from '../schema.js';

export const metaRoutes =
  (ctx: ServerContext) =>
  (app: FastifyInstance): void => {
    app.get('/meta', { schema: { response: { 200: jsonSchema(metaResponseSchema) } } }, async () => {
      const hooks = ctx.meta.hooks();
      // licensing §3.6: the edition, and nothing else about the license, is public.
      const { edition } = await ctx.license.state();
      return {
        name: SERVER_NAME,
        version: ctx.config.version,
        apiVersion: SERVER_API_VERSION,
        publicUrl: ctx.config.publicUrl,
        auth: ctx.meta.signInMethods(),
        capabilities: ctx.meta.capabilities(),
        ...(hooks !== undefined ? { hooks } : {}),
        edition,
      };
    });
  };
