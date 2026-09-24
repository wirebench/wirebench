import { z } from 'zod';

/** Fastify validates JSON Schema; zod stays the source so the desktop can share the same objects. */
export const jsonSchema = (schema: z.ZodType): Record<string, unknown> => z.toJSONSchema(schema);
