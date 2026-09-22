/**
 * Checking a REST response against the schema its OpenAPI operation declares for it.
 */
import { describe, expect, it } from 'vitest';
import {
  checkRestResponse,
  MAX_CHECKED_BODY_BYTES,
  MAX_CONTRACT_PATH_LENGTH,
  MAX_REST_CHECK_NODES,
} from '../../../src/rest/contract-check.js';
import type { OpenApiResponses } from '../../../src/rest/openapi/model.js';

const operation = { method: 'get', path: '/pets/{id}' };
const pet = {
  type: 'object',
  required: ['id', 'name'],
  properties: { id: { type: 'integer' }, name: { type: 'string' }, secret: { type: 'string', writeOnly: true } },
};
const responses: OpenApiResponses = {
  '200': { content: { 'application/json': { schema: pet } } },
  '204': {},
  '4XX': { content: { 'text/plain': {} } },
};
const base = { status: 200, contentType: 'application/json', language: 'json', streamed: false, operation, responses };

describe('checkRestResponse', () => {
  it('is ok when the body matches, naming the operation, response key and media type', () => {
    const r = checkRestResponse({ ...base, bodyText: '{"id":1,"name":"Rex"}' });
    expect(r).toEqual({
      status: 'ok',
      operation,
      responseKey: '200',
      mediaType: 'application/json',
      problems: [],
      notes: [],
    });
  });

  it('reports violations with pointer paths', () => {
    const r = checkRestResponse({ ...base, bodyText: '{"id":"1"}' });
    expect(r.status).toBe('violation');
    expect(r.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: '/id', keyword: 'type' }),
        expect.objectContaining({ path: '', keyword: 'required' }),
      ]),
    );
  });

  it('flags a writeOnly property present in a response, however deep', () => {
    const r = checkRestResponse({ ...base, bodyText: '{"id":1,"name":"Rex","secret":"s"}' });
    expect(r.status).toBe('violation');
    expect(r.problems).toEqual([expect.objectContaining({ path: '/secret', keyword: 'writeOnly' })]);

    const list: OpenApiResponses = {
      '200': { content: { 'application/json': { schema: { type: 'array', items: pet } } } },
    };
    const deep = checkRestResponse({
      ...base,
      responses: list,
      bodyText: '[{"id":1,"name":"a"},{"id":2,"name":"b","secret":"x"}]',
    });
    expect(deep.problems).toEqual([expect.objectContaining({ path: '/1/secret', keyword: 'writeOnly' })]);
  });

  it('terminates on a cyclic schema', () => {
    const node: Record<string, unknown> = { type: 'object', properties: { pw: { writeOnly: true } } };
    (node['properties'] as Record<string, unknown>)['child'] = node;
    const cyclic: OpenApiResponses = { '200': { content: { 'application/json': { schema: node } } } };
    const r = checkRestResponse({ ...base, responses: cyclic, bodyText: '{"child":{"child":{"pw":1}}}' });
    expect(r.problems).toEqual([expect.objectContaining({ path: '/child/child/pw', keyword: 'writeOnly' })]);
  });

  it('checks a schema that composes itself without crashing', () => {
    const node: Record<string, unknown> = { type: 'object' };
    node['allOf'] = [node];
    const cyclic: OpenApiResponses = { '200': { content: { 'application/json': { schema: node } } } };
    const r = checkRestResponse({ ...base, responses: cyclic, bodyText: '{}' });
    expect(r.status).toBe('ok');
  });

  it('follows only the anyOf/oneOf branches the value matches for writeOnly', () => {
    const schema = {
      anyOf: [
        { type: 'object', required: ['kind'], properties: { kind: { const: 'a' }, pw: { writeOnly: true } } },
        { type: 'object', required: ['kind'], properties: { kind: { const: 'b' }, pw: { type: 'string' } } },
      ],
    };
    const res: OpenApiResponses = { '200': { content: { 'application/json': { schema } } } };
    expect(checkRestResponse({ ...base, responses: res, bodyText: '{"kind":"b","pw":"x"}' }).status).toBe('ok');
    expect(checkRestResponse({ ...base, responses: res, bodyText: '{"kind":"a","pw":"x"}' }).problems).toEqual([
      expect.objectContaining({ path: '/pw', keyword: 'writeOnly' }),
    ]);
    const one: OpenApiResponses = { '200': { content: { 'application/json': { schema: { oneOf: schema.anyOf } } } } };
    expect(checkRestResponse({ ...base, responses: one, bodyText: '{"kind":"b","pw":"x"}' }).status).toBe('ok');
  });

  it('checks writeOnly in prefixItems', () => {
    const schema = { type: 'array', prefixItems: [{ type: 'object', properties: { pw: { writeOnly: true } } }] };
    const res: OpenApiResponses = { '200': { content: { 'application/json': { schema } } } };
    expect(checkRestResponse({ ...base, responses: res, bodyText: '[{"pw":1}]' }).problems).toEqual([
      expect.objectContaining({ path: '/0/pw', keyword: 'writeOnly' }),
    ]);
  });

  it('notes when the write-only check stops at its node cap', () => {
    const schema = { type: 'array', items: { type: 'integer' } };
    const res: OpenApiResponses = { '200': { content: { 'application/json': { schema } } } };
    const r = checkRestResponse(
      {
        ...base,
        responses: res,
        bodyText: JSON.stringify(Array.from({ length: MAX_REST_CHECK_NODES + 1 }, () => 1)),
      },
      { budgetMs: 60_000 },
    );
    expect(r.notes).toContain(`write-only check stopped after ${MAX_REST_CHECK_NODES} nodes`);
  });

  it('lists format and other unsupported keywords once each as notes', () => {
    const schema = {
      type: 'object',
      properties: { a: { type: 'string', format: 'uuid' }, b: { format: 'date' }, c: { if: {} } },
    };
    const r = checkRestResponse({
      ...base,
      responses: { '200': { content: { 'application/json': { schema } } } },
      bodyText: '{}',
    });
    expect(r.status).toBe('ok');
    expect(r.notes).toHaveLength(2);
    expect(r.notes.some((n) => n.includes('format'))).toBe(true);
    expect(r.notes.some((n) => n.includes('if'))).toBe(true);
  });

  it('caps problems at 50 and messages at 300 characters', () => {
    const schema = { type: 'array', items: { type: 'string' } };
    const r = checkRestResponse({
      ...base,
      responses: { '200': { content: { 'application/json': { schema } } } },
      bodyText: JSON.stringify(Array.from({ length: 51 }, (_, i) => i)),
    });
    expect(r.problems).toHaveLength(50);

    const long = 'x'.repeat(400);
    const r2 = checkRestResponse({
      ...base,
      responses: { '200': { content: { 'application/json': { schema: { const: long } } } } },
      bodyText: '"y"',
    });
    expect(r2.problems[0]!.message.length).toBe(300);
  });

  it('reports a body that is not JSON as a violation at the root', () => {
    const r = checkRestResponse({ ...base, bodyText: '{nope' });
    expect(r.status).toBe('violation');
    expect(r.problems).toEqual([{ path: '', keyword: 'json', message: 'not valid JSON' }]);
  });

  it('is unmatched for an undeclared status', () => {
    const r = checkRestResponse({ ...base, status: 503, bodyText: '{}' });
    expect(r.status).toBe('unmatched');
    expect(r.notes).toEqual(['the contract declares no 503 response']);
  });

  it('treats a declared empty response: ok when empty, a violation when it has a body', () => {
    expect(checkRestResponse({ ...base, status: 204, bodyText: '' }).status).toBe('ok');
    const r = checkRestResponse({ ...base, status: 204, bodyText: '{}' });
    expect(r.status).toBe('violation');
    expect(r.responseKey).toBe('204');
    expect(r.problems).toEqual([{ path: '', keyword: 'body', message: 'the contract declares no body' }]);
  });

  it('is no-schema when no declared media type has a schema', () => {
    const r = checkRestResponse({ ...base, status: 404, bodyText: '{}' });
    expect(r.status).toBe('no-schema');
    expect(r.responseKey).toBe('4XX');
  });

  it('is no-contract without an operation or responses', () => {
    expect(checkRestResponse({ ...base, operation: undefined, bodyText: '{}' }).status).toBe('no-contract');
    expect(checkRestResponse({ ...base, responses: undefined, bodyText: '{}' }).status).toBe('no-contract');
  });

  it('skips non-JSON bodies, streams and oversized bodies', () => {
    expect(checkRestResponse({ ...base, language: 'xml', bodyText: '<a/>' }).status).toBe('skipped');
    expect(checkRestResponse({ ...base, streamed: true, bodyText: '{}' }).status).toBe('skipped');
    const big = `"${'a'.repeat(MAX_CHECKED_BODY_BYTES)}"`;
    expect(checkRestResponse({ ...base, bodyText: big }).status).toBe('skipped');
  });

  it('is not-checked when the time budget runs out', () => {
    let t = 0;
    const r = checkRestResponse({ ...base, bodyText: '{"id":1,"name":"a"}' }, { budgetMs: 5, now: () => (t += 10) });
    expect(r.status).toBe('not-checked');
    expect(r.problems).toEqual([]);
    const schema = { type: 'string', format: 'uuid' };
    const res: OpenApiResponses = { '200': { content: { 'application/json': { schema } } } };
    let u = 0;
    const r2 = checkRestResponse({ ...base, responses: res, bodyText: '"x"' }, { budgetMs: 5, now: () => (u += 10) });
    expect(r2.status).toBe('not-checked');
    expect(r2.notes).toEqual(['`format` is not checked']);
  });

  describe('the node cap', () => {
    const row = {
      type: 'object',
      properties: Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`p${i}`, { type: 'integer' }])),
    };
    const rows: OpenApiResponses = {
      '200': { content: { 'application/json': { schema: { type: 'array', items: row } } } },
    };
    const body = (n: number) =>
      JSON.stringify(
        Array.from({ length: n }, () => Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`p${i}`, i]))),
      );

    it('checks a real list response of a few hundred rows to the end', () => {
      const r = checkRestResponse({ ...base, responses: rows, bodyText: body(415) }, { budgetMs: 60_000 });
      expect(r.status).toBe('ok');
      expect(r.notes).toEqual([]);
    });

    it('is not-checked, not a violation, when only the cap stopped the check', () => {
      const ints: OpenApiResponses = {
        '200': { content: { 'application/json': { schema: { type: 'array', items: { type: 'integer' } } } } },
      };
      const bodyText = JSON.stringify(Array.from({ length: MAX_REST_CHECK_NODES + 10 }, () => 1));
      const r = checkRestResponse({ ...base, responses: ints, bodyText }, { budgetMs: 60_000 });
      expect(r.status).toBe('not-checked');
      expect(r.problems).toEqual([]);
      expect(r.notes).toContain(`validation stopped after ${MAX_REST_CHECK_NODES} nodes`);
    });

    it('is a violation with a partial-check note when real problems came before the cap', () => {
      const ints: OpenApiResponses = {
        '200': { content: { 'application/json': { schema: { type: 'array', items: { type: 'integer' } } } } },
      };
      const values: unknown[] = Array.from({ length: MAX_REST_CHECK_NODES + 10 }, () => 1);
      values[0] = 'x';
      const r = checkRestResponse({ ...base, responses: ints, bodyText: JSON.stringify(values) }, { budgetMs: 60_000 });
      expect(r.status).toBe('violation');
      expect(r.problems.map((p) => p.keyword)).toEqual(['type']);
      expect(r.notes).toContain(`partial check: validation stopped after ${MAX_REST_CHECK_NODES} nodes`);
    });

    it('says so when a writeOnly branch could not be decided', () => {
      const big = { type: 'array', items: { type: 'integer' } };
      const schema = { anyOf: [big, { type: 'string' }] };
      const res: OpenApiResponses = { '200': { content: { 'application/json': { schema } } } };
      const bodyText = JSON.stringify(Array.from({ length: 10_010 }, () => 1));
      const r = checkRestResponse({ ...base, responses: res, bodyText }, { budgetMs: 60_000 });
      expect(r.status).toBe('ok');
      expect(r.notes.some((n) => n.includes('could not tell'))).toBe(true);
    });
  });

  it('keeps the body out of problem messages', () => {
    const schema = {
      type: 'object',
      properties: { n: { type: 'integer', minimum: 0 }, s: { type: 'string', maxLength: 10 }, e: { enum: ['a', 'b'] } },
    };
    const res: OpenApiResponses = { '200': { content: { 'application/json': { schema } } } };
    const r = checkRestResponse({ ...base, responses: res, bodyText: '{"n":-7345,"s":"zqxjkvbnmwpt","e":"hunter2"}' });
    expect(r.status).toBe('violation');
    expect(r.problems.map((p) => p.message)).toEqual([
      'below the minimum 0',
      'longer than the maximum length 10',
      'not one of the allowed values',
    ]);
    const text = JSON.stringify(r);
    for (const leaked of ['7345', 'zqxjkvbnmwpt', 'hunter2', '12']) expect(text).not.toContain(leaked);
  });

  it('clips a long problem path', () => {
    const key = 'k'.repeat(1000);
    const schema = { type: 'object', properties: { [key]: { type: 'integer' } } };
    const res: OpenApiResponses = { '200': { content: { 'application/json': { schema } } } };
    const r = checkRestResponse({ ...base, responses: res, bodyText: JSON.stringify({ [key]: 'x' }) });
    expect(r.problems[0]?.path.length).toBe(MAX_CONTRACT_PATH_LENGTH);
  });

  it('reads a JSON body with no Content-Type as application/json', () => {
    const r = checkRestResponse({ ...base, contentType: undefined, bodyText: '{"id":"1"}' });
    expect(r).toMatchObject({ status: 'violation', mediaType: 'application/json' });
    expect(checkRestResponse({ ...base, contentType: '', bodyText: '{"id":1,"name":"a"}' }).status).toBe('ok');
  });
});
