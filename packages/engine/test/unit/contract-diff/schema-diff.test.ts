import { describe, expect, it } from 'vitest';
import type { MessageSide } from '../../../src/contract-diff/model.js';
import { diffSchemas } from '../../../src/contract-diff/schema-diff.js';

/** `kind severity location` per change, the shape every row of spec §3.3 is checked in. */
function diff(before: unknown, after: unknown, side: MessageSide, xmlOccurrence = false): string[] {
  return diffSchemas(before, after, { side, location: side, operation: 'op', xmlOccurrence }).map(
    (change) => `${change.kind} ${change.severity} ${change.location ?? ''}`,
  );
}

const object = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
  type: 'object',
  properties,
  required,
});

const S = { type: 'string' };

describe('diffSchemas — the classification table (spec §3.3)', () => {
  it('a required field added breaks the request only', () => {
    const before = object({ a: S }, ['a']);
    const after = object({ a: S, b: S }, ['a', 'b']);
    expect(diff(before, after, 'request')).toEqual(['field-added breaking request.b']);
    expect(diff(before, after, 'response')).toEqual(['field-added compatible response.b']);
  });

  it('an optional field added is compatible on both sides', () => {
    const before = object({ a: S });
    const after = object({ a: S, b: S });
    expect(diff(before, after, 'request')).toEqual(['field-added compatible request.b']);
    expect(diff(before, after, 'response')).toEqual(['field-added compatible response.b']);
  });

  it('a field removed breaks both sides', () => {
    const before = object({ a: S, b: S });
    const after = object({ a: S });
    expect(diff(before, after, 'request')).toEqual(['field-removed breaking request.b']);
    expect(diff(before, after, 'response')).toEqual(['field-removed breaking response.b']);
  });

  it('a field made required breaks the request; made optional breaks the response', () => {
    const optional = object({ a: S });
    const required = object({ a: S }, ['a']);
    expect(diff(optional, required, 'request')).toEqual(['field-required breaking request.a']);
    expect(diff(optional, required, 'response')).toEqual(['field-required compatible response.a']);
    expect(diff(required, optional, 'request')).toEqual(['field-optional compatible request.a']);
    expect(diff(required, optional, 'response')).toEqual(['field-optional breaking response.a']);
  });

  it('a narrowed type breaks the request, a widened one the response, an unrelated one both', () => {
    const number = { type: 'number' };
    const integer = { type: 'integer' };
    expect(diff(number, integer, 'request')).toEqual(['type-narrowed breaking request']);
    expect(diff(number, integer, 'response')).toEqual(['type-narrowed compatible response']);
    expect(diff(integer, number, 'request')).toEqual(['type-widened compatible request']);
    expect(diff(integer, number, 'response')).toEqual(['type-widened breaking response']);
    expect(diff(S, integer, 'request')).toEqual(['type-changed breaking request']);
    expect(diff(S, integer, 'response')).toEqual(['type-changed breaking response']);
  });

  it('reads OpenAPI 3.0 nullable and a nillable anyOf as a null type', () => {
    expect(diff({ type: 'string', nullable: true }, S, 'request')).toEqual(['type-narrowed breaking request']);
    expect(diff(S, { anyOf: [S, { type: 'null' }] }, 'response')).toEqual(['type-widened breaking response']);
    expect(diff({ type: ['string', 'null'] }, { type: 'string', nullable: true }, 'request')).toEqual([]);
  });

  it('enumeration values removed break the request, added break the response', () => {
    const before = { type: 'string', enum: ['a', 'b'] };
    const after = { type: 'string', enum: ['b', 'c'] };
    expect(diff(before, after, 'request')).toEqual([
      'enum-values-removed breaking request',
      'enum-values-added compatible request',
    ]);
    expect(diff(before, after, 'response')).toEqual([
      'enum-values-removed compatible response',
      'enum-values-added breaking response',
    ]);
  });

  it('an enumeration introduced narrows; one dropped widens', () => {
    const limited = { type: 'string', enum: ['a'] };
    expect(diff(S, limited, 'request')).toEqual(['enum-values-removed breaking request']);
    expect(diff(limited, S, 'response')).toEqual(['enum-values-added breaking response']);
  });

  it('a narrowed constraint breaks the request only; a widened one breaks nothing', () => {
    expect(diff({ type: 'string', maxLength: 10 }, { type: 'string', maxLength: 5 }, 'request')).toEqual([
      'constraint-narrowed breaking request',
    ]);
    expect(diff({ type: 'string', maxLength: 10 }, { type: 'string', maxLength: 5 }, 'response')).toEqual([
      'constraint-narrowed compatible response',
    ]);
    expect(diff({ type: 'integer', minimum: 1 }, { type: 'integer' }, 'request')).toEqual([
      'constraint-widened compatible request',
    ]);
    expect(diff(S, { type: 'string', pattern: '^a$' }, 'request')).toEqual(['constraint-narrowed breaking request']);
    expect(diff({ type: 'string', pattern: '^a$' }, { type: 'string', pattern: '^b$' }, 'request')).toEqual([
      'constraint-narrowed breaking request',
    ]);
  });

  it('knows the format widenings', () => {
    expect(diff({ type: 'integer', format: 'int32' }, { type: 'integer', format: 'int64' }, 'request')).toEqual([
      'constraint-widened compatible request',
    ]);
    expect(diff({ type: 'integer', format: 'int64' }, { type: 'integer', format: 'int32' }, 'request')).toEqual([
      'constraint-narrowed breaking request',
    ]);
  });

  it('does not repeat a type change as a bounds change', () => {
    const decimal = { type: 'number' };
    const int = { type: 'integer', minimum: -(2 ** 31), maximum: 2 ** 31 - 1 };
    expect(diff(decimal, int, 'request')).toEqual(['type-narrowed breaking request']);
  });

  it('ignores documentation', () => {
    expect(diff({ ...S, description: 'a' }, { ...S, description: 'b', title: 't' }, 'request')).toEqual([]);
  });
});

describe('diffSchemas — structure', () => {
  it('names nested fields and array items in the location', () => {
    const before = object({ items: { type: 'array', items: object({ sku: S }) } });
    const after = object({ items: { type: 'array', items: object({ sku: { type: 'integer' } }) } });
    expect(diff(before, after, 'request')).toEqual(['type-changed breaking request.items[].sku']);
  });

  it('follows $refs into $defs on each side', () => {
    const before = { $defs: { T: object({ a: S }) }, ...object({ t: { $ref: '#/$defs/T' } }) };
    const after = { $defs: { T: object({ a: S }, ['a']) }, ...object({ t: { $ref: '#/$defs/T' } }) };
    expect(diff(before, after, 'request')).toEqual(['field-required breaking request.t.a']);
  });

  it('terminates on a self-referencing $ref and on a cyclic resolved graph', () => {
    const before = { $defs: { N: object({ next: { $ref: '#/$defs/N' }, v: S }) }, $ref: '#/$defs/N' };
    const after = { $defs: { N: object({ next: { $ref: '#/$defs/N' }, v: { type: 'integer' } }) }, $ref: '#/$defs/N' };
    expect(diff(before, after, 'response')).toEqual(['type-changed breaking response.v']);

    const cyclicOld: Record<string, unknown> = { type: 'object', properties: { v: S } };
    (cyclicOld['properties'] as Record<string, unknown>)['self'] = cyclicOld;
    const cyclicNew: Record<string, unknown> = { type: 'object', properties: { v: S, w: S } };
    (cyclicNew['properties'] as Record<string, unknown>)['self'] = cyclicNew;
    expect(diff(cyclicOld, cyclicNew, 'response')).toEqual(['field-added compatible response.w']);
  });

  it('counts alternatives: more oneOf options widen, more allOf parts narrow', () => {
    expect(diff({ oneOf: [S] }, { oneOf: [S, { type: 'integer' }] }, 'response')).toEqual([
      'type-widened breaking response',
    ]);
    expect(diff({ allOf: [S] }, { allOf: [S, { maxLength: 3 }] }, 'request')).toEqual([
      'type-narrowed breaking request',
    ]);
  });

  it('treats a single XML element becoming repeating as a widening, and the reverse as a narrowing', () => {
    const single = object({ line: S }, ['line']);
    const repeating = object({ line: { type: 'array', items: S, minItems: 1 } }, ['line']);
    expect(diff(single, repeating, 'request', true)).toEqual(['type-widened compatible request.line']);
    expect(diff(single, repeating, 'response', true)).toEqual(['type-widened breaking response.line']);
    expect(diff(repeating, single, 'request', true)).toEqual(['type-narrowed breaking request.line']);
    // In JSON, a value becoming an array is a different type.
    expect(diff(single, repeating, 'request')).toEqual(['type-changed breaking request.line']);
  });

  it('carries the operation on every change', () => {
    const [change] = diffSchemas(S, { type: 'integer' }, { side: 'request', location: 'request', operation: 'X#Y' });
    expect(change?.operation).toBe('X#Y');
    expect(change?.message).toBe('type string became integer');
  });
});
