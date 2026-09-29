import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { jsonSchema } from '../../src/schema.js';

const keysNamed = (value: unknown, name: string, path = '$'): string[] => {
  if (Array.isArray(value)) return value.flatMap((item, index) => keysNamed(item, name, `${path}[${String(index)}]`));
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => [
    ...(key === name ? [`${path}.${key}`] : []),
    ...keysNamed(child, name, `${path}.${key}`),
  ]);
};

describe('jsonSchema', () => {
  const schema = z.object({
    default: z.string(),
    retries: z.number().default(3),
    scheme: z.union([
      z.object({ kind: z.literal('a'), toleranceSec: z.number().default(300) }),
      z.object({ kind: z.literal('b') }),
    ]),
    tags: z.record(z.string(), z.object({ weight: z.number().default(1) })),
  });

  it("drops every default keyword for io: 'input', in nested and union positions too", () => {
    const out = jsonSchema(schema, { io: 'input' });
    expect(keysNamed(out, 'default')).toEqual(['$.properties.default']);
  });

  it('keeps a property literally named default, with its schema and its place in required', () => {
    const out = jsonSchema(schema, { io: 'input' }) as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(out.properties.default).toEqual({ type: 'string' });
    expect(out.required).toContain('default');
    expect(out.required).not.toContain('retries');
  });

  it("keeps defaults for io: 'output'", () => {
    const out = jsonSchema(schema);
    expect(keysNamed(out, 'default').length).toBeGreaterThan(1);
  });
});
