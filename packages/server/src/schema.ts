import { z } from 'zod';

/**
 * Fastify validates JSON Schema; zod stays the source so the desktop can share the same objects.
 * Fastify's default Ajv instance only understands draft-07 — `z.toJSONSchema`'s own default
 * (draft 2020-12) makes `app.ready()` throw `no schema with key or ref
 * "https://json-schema.org/draft/2020-12/schema"` the first time any route uses it, so every call
 * here pins `target: 'draft-7'`.
 *
 * `io` picks which side of the schema to emit: `'output'` (the default) is what the server sends
 * back, so use it for response schemas; `'input'` is what the client is allowed to send — fields
 * with a `.default()` become optional and defaults are dropped — so request (body/querystring/
 * params) schemas should pass `io: 'input'`.
 */
export const jsonSchema = (
  schema: z.ZodType,
  options: { readonly io?: 'input' | 'output' } = {},
): Record<string, unknown> => z.toJSONSchema(schema, { target: 'draft-7', io: options.io ?? 'output' });
