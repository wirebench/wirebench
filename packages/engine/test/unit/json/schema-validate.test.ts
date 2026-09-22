import { describe, expect, it } from 'vitest';
import { validateJsonSchema, unsupportedKeywordsIn } from '../../../src/json/schema-validate.js';

const message = {
  type: 'object',
  required: ['type', 'text'],
  additionalProperties: false,
  properties: {
    type: { const: 'chat' },
    text: { type: 'string', minLength: 1, maxLength: 5 },
    tags: { type: 'array', items: { type: 'string' }, maxItems: 2 },
    n: { type: 'integer', minimum: 0, exclusiveMaximum: 10 },
  },
};

describe('validateJsonSchema', () => {
  it('passes a conforming value', () => {
    expect(validateJsonSchema({ type: 'chat', text: 'hi', n: 3 }, message)).toEqual([]);
  });
  it('reports each problem with a JSON pointer', () => {
    const problems = validateJsonSchema({ type: 'x', text: '', tags: ['a', 1, 'c'], n: 10, extra: true }, message);
    expect(problems.map((p) => `${p.path} ${p.keyword}`)).toEqual([
      '/type const',
      '/text minLength',
      '/tags maxItems',
      '/tags/1 type',
      '/n exclusiveMaximum',
      '/extra additionalProperties',
    ]);
  });
  it('reports a missing required property at the object', () => {
    expect(validateJsonSchema({ type: 'chat' }, message)).toEqual([
      { path: '', keyword: 'required', message: 'missing required property "text"' },
    ]);
  });
  it('oneOf needs exactly one branch', () => {
    const s = { oneOf: [{ type: 'string' }, { type: 'string', maxLength: 3 }] };
    expect(validateJsonSchema('ab', s)[0]?.keyword).toBe('oneOf');
    expect(validateJsonSchema('abcd', s)).toEqual([]);
  });
  it('treats nullable and a type list as allowing null', () => {
    expect(validateJsonSchema(null, { type: 'string', nullable: true })).toEqual([]);
    expect(validateJsonSchema(null, { type: ['string', 'null'] })).toEqual([]);
  });
  it('an unresolved $ref and an unsupported keyword pass', () => {
    expect(validateJsonSchema(1, { $ref: '#/nope' })).toEqual([]);
    expect(validateJsonSchema('x', { if: { type: 'string' }, then: { minLength: 5 } })).toEqual([]);
    expect(unsupportedKeywordsIn({ properties: { a: { if: {}, format: 'email' } } })).toEqual(['format', 'if']);
  });
  it('stops at the problem and node caps', () => {
    const many = Array.from({ length: 100 }, () => 1);
    expect(validateJsonSchema(many, { items: { type: 'string' } })).toHaveLength(20);
    expect(validateJsonSchema(many, { items: { type: 'string' } }, { maxNodes: 10 }).at(-1)?.keyword).toBe('budget');
  });
  it('an invalid pattern is ignored rather than thrown', () => {
    expect(validateJsonSchema('a', { pattern: '(' })).toEqual([]);
  });
  it('a nested unbounded quantifier pattern is reported not checked, never evaluated', () => {
    const evil = 'a'.repeat(35) + '!';
    const started = Date.now();
    // Assembled, so the source holds no literal of the very shape the validator refuses to run.
    const problems = validateJsonSchema(evil, { pattern: ['(a+)', '+$'].join('') });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.keyword).toBe('pattern');
    expect(problems[0]?.message).toContain('not checked');
  });
  it('a normal pattern still validates', () => {
    expect(validateJsonSchema('abc', { pattern: '^[a-z]+$' })).toEqual([]);
    const problems = validateJsonSchema('ABC', { pattern: '^[a-z]+$' });
    expect(problems).toEqual([{ path: '', keyword: 'pattern', message: 'does not match /^[a-z]+$/' }]);
  });
  it('a value longer than the pattern length cap is reported not checked', () => {
    const long = 'a'.repeat(5000);
    const problems = validateJsonSchema(long, { pattern: '^[a-z]*$' });
    expect(problems).toHaveLength(1);
    expect(problems[0]?.keyword).toBe('pattern');
    expect(problems[0]?.message).toContain('not checked');
  });
  it('a lookaround or backreference pattern is reported not checked', () => {
    expect(validateJsonSchema('ab', { pattern: '(?=a)b' })[0]?.message).toContain('not checked');
    expect(validateJsonSchema('aa', { pattern: '(a)\\1' })[0]?.message).toContain('not checked');
  });
});

describe('additionalItems', () => {
  it('rejects an extra tuple item when additionalItems is false', () => {
    const s = { items: [{ type: 'string' }], additionalItems: false };
    expect(validateJsonSchema(['a'], s)).toEqual([]);
    expect(validateJsonSchema(['a', 'extra'], s)).toEqual([
      { path: '/1', keyword: 'additionalItems', message: 'unexpected item beyond the tuple' },
    ]);
  });
  it('validates an extra tuple item against a schema', () => {
    const s = { items: [{ type: 'string' }], additionalItems: { type: 'number' } };
    expect(validateJsonSchema(['a', 5], s)).toEqual([]);
    expect(validateJsonSchema(['a', 'x'], s)[0]?.keyword).toBe('type');
  });
});

describe('number checks', () => {
  it('minimum, maximum and multipleOf pass when the value is within bounds', () => {
    expect(validateJsonSchema(5, { minimum: 1, maximum: 10, multipleOf: 1 })).toEqual([]);
  });
  it('reports a value below minimum, above maximum, and not a multiple', () => {
    expect(validateJsonSchema(0, { minimum: 1 })[0]).toMatchObject({ keyword: 'minimum' });
    expect(validateJsonSchema(11, { maximum: 10 })[0]).toMatchObject({ keyword: 'maximum' });
    expect(validateJsonSchema(4, { multipleOf: 3 })[0]).toMatchObject({ keyword: 'multipleOf' });
  });
  it('exclusiveMinimum and exclusiveMaximum as numbers pass and fail correctly', () => {
    expect(validateJsonSchema(5, { exclusiveMinimum: 1, exclusiveMaximum: 10 })).toEqual([]);
    expect(validateJsonSchema(1, { exclusiveMinimum: 1 })[0]).toMatchObject({ keyword: 'exclusiveMinimum' });
    expect(validateJsonSchema(10, { exclusiveMaximum: 10 })[0]).toMatchObject({ keyword: 'exclusiveMaximum' });
  });
  it('draft-04 style exclusiveMinimum/Maximum booleans pass and fail correctly', () => {
    expect(validateJsonSchema(5, { minimum: 1, exclusiveMinimum: true })).toEqual([]);
    expect(validateJsonSchema(1, { minimum: 1, exclusiveMinimum: true })[0]).toMatchObject({
      keyword: 'exclusiveMinimum',
    });
    expect(validateJsonSchema(5, { maximum: 10, exclusiveMaximum: true })).toEqual([]);
    expect(validateJsonSchema(10, { maximum: 10, exclusiveMaximum: true })[0]).toMatchObject({
      keyword: 'exclusiveMaximum',
    });
  });
});

describe('array checks', () => {
  it('minItems and maxItems pass within bounds and fail outside them', () => {
    expect(validateJsonSchema([1, 2], { minItems: 1, maxItems: 3 })).toEqual([]);
    expect(validateJsonSchema([], { minItems: 1 })[0]).toMatchObject({ keyword: 'minItems' });
    expect(validateJsonSchema([1, 2, 3, 4], { maxItems: 3 })[0]).toMatchObject({ keyword: 'maxItems' });
  });
  it('uniqueItems passes distinct items and reports a duplicate', () => {
    expect(validateJsonSchema([1, 2, 3], { uniqueItems: true })).toEqual([]);
    expect(validateJsonSchema([1, 2, 1], { uniqueItems: true })[0]).toMatchObject({ keyword: 'uniqueItems' });
  });
  it('a tuple schema validates each position against its own schema', () => {
    const s = { items: [{ type: 'string' }, { type: 'number' }] };
    expect(validateJsonSchema(['a', 1], s)).toEqual([]);
    expect(validateJsonSchema([1, 1], s)[0]).toMatchObject({ path: '/0', keyword: 'type' });
  });
});

describe('object checks', () => {
  it('minProperties and maxProperties pass within bounds and fail outside them', () => {
    expect(validateJsonSchema({ a: 1 }, { minProperties: 1, maxProperties: 2 })).toEqual([]);
    expect(validateJsonSchema({}, { minProperties: 1 })[0]).toMatchObject({ keyword: 'minProperties' });
    expect(validateJsonSchema({ a: 1, b: 2, c: 3 }, { maxProperties: 2 })[0]).toMatchObject({
      keyword: 'maxProperties',
    });
  });
  it('patternProperties validates a matching key and lets an unsafe pattern through unchecked', () => {
    const s = { patternProperties: { '^x-': { type: 'string' } } };
    expect(validateJsonSchema({ 'x-a': 'ok' }, s)).toEqual([]);
    expect(validateJsonSchema({ 'x-a': 1 }, s)[0]).toMatchObject({ keyword: 'type' });
    expect(
      validateJsonSchema({ 'x-a': 'ok' }, { patternProperties: { '(a+)+$': { type: 'string' } } })[0],
    ).toMatchObject({ keyword: 'patternProperties' });
  });
  it('additionalProperties as a schema validates the extra property', () => {
    const s = { properties: { a: { type: 'string' } }, additionalProperties: { type: 'number' } };
    expect(validateJsonSchema({ a: 'x', b: 5 }, s)).toEqual([]);
    expect(validateJsonSchema({ a: 'x', b: 'nope' }, s)[0]).toMatchObject({ path: '/b', keyword: 'type' });
  });
});

describe('allOf', () => {
  it('passes when every branch passes, and reports the first branch that fails', () => {
    const s = { allOf: [{ type: 'string' }, { minLength: 2 }] };
    expect(validateJsonSchema('ab', s)).toEqual([]);
    expect(validateJsonSchema('a', s)[0]).toMatchObject({ keyword: 'minLength' });
  });
});

describe('not', () => {
  it('passes when the value does not match the disallowed schema', () => {
    expect(validateJsonSchema('x', { not: { type: 'number' } })).toEqual([]);
  });
});

describe('a combinator branch that runs out of nodes', () => {
  // Twenty strings: walking them against `items` costs more nodes than the budget allows.
  const many = Array.from({ length: 20 }, () => 'x');
  const expensive = { type: 'array', items: { type: 'string' } };

  it('is neither a match nor a mismatch for oneOf: no oneOf verdict, only the budget stop', () => {
    const problems = validateJsonSchema(many, { oneOf: [{ type: 'array' }, expensive] }, { maxNodes: 10 });
    expect(problems.map((p) => p.keyword)).toEqual(['budget']);
  });

  it('is not a pass for anyOf: the stop is reported instead of a silent success', () => {
    const problems = validateJsonSchema(many, { anyOf: [expensive, { type: 'string' }] }, { maxNodes: 10 });
    expect(problems.map((p) => p.keyword)).toEqual(['budget']);
  });

  it('is not a pass for not: no not verdict, only the budget stop', () => {
    const problems = validateJsonSchema(many, { not: expensive }, { maxNodes: 10 });
    expect(problems.map((p) => p.keyword)).toEqual(['budget']);
  });
});
