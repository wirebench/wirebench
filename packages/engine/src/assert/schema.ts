import { z } from 'zod';

const name = z.string().min(1).optional();
const statusValue = z.union([z.number().int().min(100).max(599), z.string().regex(/^[1-5]xx$/)]);

const statusSchema = z.looseObject({
  type: z.literal('status'),
  equals: z.union([statusValue, z.array(statusValue).min(1)]),
  name,
});

const soapFaultSchema = z.looseObject({
  type: z.literal('soap-fault'),
  expect: z.enum(['none', 'present']).default('none'),
  name,
});

const matchSchema = z.looseObject({
  type: z.literal('match'),
  language: z.enum(['xpath', 'xquery', 'jsonpath']),
  expression: z.string().min(1),
  namespaces: z.record(z.string(), z.string()).optional(),
  equals: z.union([z.string(), z.number(), z.boolean()]).optional(),
  matches: z.string().optional(),
  exists: z.boolean().optional(),
  name,
});

const schemaSchema = z.looseObject({ type: z.literal('schema'), name });
const slaSchema = z.looseObject({ type: z.literal('sla'), maxMs: z.number().int().positive(), name });

const assertionSchema = z
  .discriminatedUnion('type', [statusSchema, soapFaultSchema, matchSchema, schemaSchema, slaSchema])
  .superRefine((value, ctx) => {
    if (value.type !== 'match') {
      return;
    }
    const given = [value.equals, value.matches, value.exists].filter((v) => v !== undefined).length;
    if (given !== 1) {
      ctx.addIssue({ code: 'custom', message: 'exactly one of equals, matches or exists is required' });
    }
    if (value.matches !== undefined) {
      try {
        new RegExp(value.matches);
      } catch {
        ctx.addIssue({ code: 'custom', path: ['matches'], message: 'not a valid regular expression' });
      }
    }
  });

/** The `assertions:` list of a request file. `looseObject` like every project schema; see `project/schema.ts`. */
export const assertionsSchema = z.array(assertionSchema);
