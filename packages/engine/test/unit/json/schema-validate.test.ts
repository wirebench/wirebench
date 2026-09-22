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
});
