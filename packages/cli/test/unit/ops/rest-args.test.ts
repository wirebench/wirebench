// packages/cli/test/unit/ops/rest-args.test.ts
import { describe, expect, it } from 'vitest';
import type { OpenApiOperation, RestApi } from '@wirebench/engine';
import { restToolSchema } from '../../../src/ops/rest-args.js';

const API = {
  auth: { type: 'api-key', name: 'X-Key', in: 'header', valueRef: 'key' },
} as unknown as RestApi;

describe('restToolSchema', () => {
  it('turns shared and recursive schema nodes into $defs, drops readOnly from a body, and leaves auth headers out', () => {
    const node: Record<string, unknown> = { type: 'object', title: 'Node', properties: {} };
    (node['properties'] as Record<string, unknown>)['next'] = node;
    const money = { type: 'number' };
    const operation = {
      method: 'post',
      path: '/nodes/{id}',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'limit', in: 'query', schema: { type: 'integer' } },
        { name: 'X-Key', in: 'header', schema: { type: 'string' } },
        { name: 'X-Trace', in: 'header', required: true, schema: { type: 'string' } },
        { name: 'session', in: 'cookie', required: true, schema: { type: 'string' } },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['id', 'root'],
              properties: {
                id: { type: 'string', readOnly: true },
                root: node,
                price: money,
                cost: money,
                tag: { type: 'string', nullable: true },
              },
            },
          },
        },
      },
    } as unknown as OpenApiOperation;

    const { schema, cookies } = restToolSchema(API, operation);
    expect(cookies).toEqual(['session']);
    expect(schema).toEqual({
      type: 'object',
      properties: {
        path: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
          additionalProperties: false,
        },
        query: { type: 'object', properties: { limit: { type: 'integer' } }, additionalProperties: false },
        headers: {
          type: 'object',
          properties: { 'X-Trace': { type: 'string' } },
          required: ['X-Trace'],
          additionalProperties: false,
        },
        body: {
          type: 'object',
          required: ['root'],
          properties: {
            root: { $ref: '#/$defs/Node' },
            price: { $ref: '#/$defs/Schema1' },
            cost: { $ref: '#/$defs/Schema1' },
            tag: { type: ['string', 'null'] },
          },
        },
      },
      required: ['path', 'headers', 'body'],
      additionalProperties: false,
      $defs: {
        Node: { type: 'object', title: 'Node', properties: { next: { $ref: '#/$defs/Node' } } },
        Schema1: { type: 'number' },
      },
    });
  });

  it('takes a non-JSON body as a string sent with its media type', () => {
    const operation = {
      method: 'put',
      path: '/notes',
      parameters: [],
      requestBody: { content: { 'text/plain': { schema: { type: 'string' } } } },
    } as unknown as OpenApiOperation;
    expect(restToolSchema(API, operation).schema['properties']).toEqual({
      body: { type: 'string', description: 'Sent as text/plain' },
    });
  });
});
