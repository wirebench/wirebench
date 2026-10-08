/**
 * A REST request against its OpenAPI operation (mock services spec §Validation → REST): parameters by
 * location and type, arrays, required values, the media type and a JSON body — with values kept out
 * of every message.
 */
import { describe, expect, it } from 'vitest';
import type { JsonSchema, OpenApiOperation } from '../../../src/rest/openapi/model.js';
import { checkRestRequest } from '../../../src/rest/request-check.js';
import type { RestRequestInput } from '../../../src/rest/request-check.js';

/** Validation keywords the sample model does not type; the validator reads them. */
const s = (schema: JsonSchema & Readonly<Record<string, unknown>>): JsonSchema => schema;

const OPERATION: OpenApiOperation = {
  method: 'post',
  path: '/orders/{id}',
  parameters: [
    { name: 'id', in: 'path', required: true, schema: s({ type: 'integer', minimum: 1 }) },
    { name: 'limit', in: 'query', schema: s({ type: 'integer', maximum: 100 }) },
    { name: 'dry', in: 'query', schema: { type: 'boolean' } },
    { name: 'tag', in: 'query', schema: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } } },
    { name: 'X-Tenant', in: 'header', required: true, schema: s({ type: 'string', pattern: '^t-' }) },
    { name: 'session', in: 'cookie', schema: s({ type: 'string', minLength: 3 }) },
    { name: 'filter', in: 'query', style: 'deepObject', schema: { type: 'object' } },
  ],
  requestBody: {
    required: true,
    content: {
      'application/json': {
        schema: {
          type: 'object',
          required: ['qty'],
          properties: { qty: s({ type: 'integer', minimum: 1 }), note: { type: 'string' } },
          additionalProperties: false,
        },
      },
    },
  },
};

function input(over: Partial<RestRequestInput> = {}): RestRequestInput {
  return {
    operation: OPERATION,
    pathParams: { id: '7' },
    query: {},
    headers: [
      ['X-Tenant', 't-1'],
      ['Content-Type', 'application/json'],
    ],
    bodyText: '{"qty":2}',
    ...over,
  };
}

const where = (result: ReturnType<typeof checkRestRequest>) =>
  result.problems.map((p) => `${p.in}:${p.name ?? ''}${p.path}`);

describe('checkRestRequest', () => {
  it('passes a conforming request', () => {
    const result = checkRestRequest(input({ query: { limit: ['5'], dry: ['true'], tag: ['a', 'b'] } }));
    expect(result.problems).toEqual([]);
    expect(result.unsupportedMediaType).toBe(false);
  });

  it('converts each parameter to its type before validating it', () => {
    const result = checkRestRequest(
      input({ pathParams: { id: '0' }, query: { limit: ['500'], dry: ['maybe'], tag: ['c'] } }),
    );
    expect(where(result)).toEqual(['path:id', 'query:limit', 'query:dry', 'query:tag/0']);
  });

  it('reports a missing required parameter, header and body', () => {
    const result = checkRestRequest(input({ pathParams: {}, headers: [], bodyText: '' }));
    expect(where(result)).toEqual(['path:id', 'header:X-Tenant', 'body:']);
  });

  it('reads headers by any case and cookies from Cookie', () => {
    const result = checkRestRequest(
      input({
        headers: [
          ['x-tenant', 'nope'],
          ['Content-Type', 'application/json'],
          ['Cookie', 'a=1; session=xy'],
        ],
      }),
    );
    expect(where(result)).toEqual(['header:X-Tenant', 'cookie:session']);
  });

  it('notes a parameter style it does not parse instead of failing it', () => {
    const result = checkRestRequest(input({ query: { 'filter[a]': ['1'], filter: ['x'] } }));
    expect(result.problems).toEqual([]);
    expect(result.notes.join(' ')).toContain('deepObject');
  });

  it('flags a media type the operation does not accept', () => {
    const result = checkRestRequest(
      input({
        headers: [
          ['X-Tenant', 't-1'],
          ['Content-Type', 'text/plain'],
        ],
      }),
    );
    expect(result.unsupportedMediaType).toBe(true);
  });

  it('validates a JSON body and leaves its values out of the messages', () => {
    const result = checkRestRequest(input({ bodyText: '{"qty":-123456,"extra":"secret-value"}' }));
    expect(where(result)).toEqual(expect.arrayContaining(['body:/qty']));
    expect(result.problems.length).toBeGreaterThanOrEqual(2);
    const text = JSON.stringify(result.problems);
    expect(text).not.toContain('-123456');
    expect(text).not.toContain('secret-value');
    expect(checkRestRequest(input({ bodyText: '{nope' })).problems[0]?.message).toContain('not valid JSON');
  });
});
