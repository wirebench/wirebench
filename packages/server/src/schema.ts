import { z } from 'zod';

/** Keywords whose value maps names to schemas: their keys are names, never keywords. */
const NAME_MAPS = new Set(['properties', 'patternProperties', 'definitions', '$defs']);
/** Keywords whose value is data, not a schema: left exactly as emitted. */
const DATA_KEYWORDS = new Set(['const', 'enum', 'examples']);

/** A schema position with every `default` keyword removed, walked structurally. */
function withoutDefaults(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(withoutDefaults);
  if (typeof schema !== 'object' || schema === null) return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (key === 'default') continue;
    if (DATA_KEYWORDS.has(key)) out[key] = value;
    else if (NAME_MAPS.has(key) && typeof value === 'object' && value !== null && !Array.isArray(value)) {
      out[key] = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([name, child]) => [name, withoutDefaults(child)]),
      );
    } else out[key] = withoutDefaults(value);
  }
  return out;
}

/**
 * Fastify validates JSON Schema; zod stays the source so the desktop can share the same objects.
 * Fastify's default Ajv instance only understands draft-07 — `z.toJSONSchema`'s own default
 * (draft 2020-12) makes `app.ready()` throw `no schema with key or ref
 * "https://json-schema.org/draft/2020-12/schema"` the first time any route uses it, so every call
 * here pins `target: 'draft-7'`.
 *
 * `io` picks which side of the schema to emit: `'output'` (the default) is what the server sends
 * back, so use it for response schemas; `'input'` is what the client is allowed to send — fields
 * with a `.default()` become optional and the `default` keywords are dropped — so request (body/
 * querystring/params) schemas should pass `io: 'input'`. zod keeps `default` in its input output,
 * and Fastify's strict Ajv refuses one inside a `oneOf`/`anyOf` branch, so they are stripped here;
 * handlers apply defaults themselves (a zod re-parse or `??`). Keys under `properties`,
 * `patternProperties`, `definitions` and `$defs` are property names, so a field called `default`
 * survives.
 */
export const jsonSchema = (
  schema: z.ZodType,
  options: { readonly io?: 'input' | 'output' } = {},
): Record<string, unknown> => {
  const io = options.io ?? 'output';
  const out = z.toJSONSchema(schema, { target: 'draft-7', io });
  return io === 'input' ? (withoutDefaults(out) as Record<string, unknown>) : out;
};
