import { describe, expect, it } from 'vitest';
import { assertionsSchema } from '../../../src/assert/schema.js';

describe('assertionsSchema', () => {
  it('accepts one of each type and defaults soap-fault to none', () => {
    const parsed = assertionsSchema.parse([
      { type: 'status', equals: [200, '2xx'] },
      { type: 'soap-fault' },
      { type: 'match', language: 'xpath', expression: '//a', exists: true },
      { type: 'schema' },
      { type: 'sla', maxMs: 800 },
    ]);
    expect(parsed[1]).toEqual({ type: 'soap-fault', expect: 'none' });
  });

  it('refuses a match with none, or more than one, of equals / matches / exists', () => {
    const base = { type: 'match', language: 'xpath', expression: '//a' };
    expect(assertionsSchema.safeParse([base]).success).toBe(false);
    expect(assertionsSchema.safeParse([{ ...base, equals: 'x', exists: true }]).success).toBe(false);
  });

  it('refuses a status class that is not Nxx, a non-positive SLA and a bad regex', () => {
    expect(assertionsSchema.safeParse([{ type: 'status', equals: '20x' }]).success).toBe(false);
    expect(assertionsSchema.safeParse([{ type: 'sla', maxMs: 0 }]).success).toBe(false);
    expect(
      assertionsSchema.safeParse([{ type: 'match', language: 'xpath', expression: '//a', matches: '(' }]).success,
    ).toBe(false);
  });

  it('accepts a gRPC status name and rejects an unknown name and 17', () => {
    expect(assertionsSchema.safeParse([{ type: 'status', equals: 'NOT_FOUND' }]).success).toBe(true);
    expect(assertionsSchema.safeParse([{ type: 'status', equals: 'NOPE' }]).success).toBe(false);
    expect(assertionsSchema.safeParse([{ type: 'status', equals: 17 }]).success).toBe(false);
  });

  it('refuses an unknown type', () => {
    expect(assertionsSchema.safeParse([{ type: 'script' }]).success).toBe(false);
  });
});
