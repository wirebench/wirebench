// packages/cli/test/unit/ops/rest-args.test.ts
import { describe, expect, it } from 'vitest';
import type { OpenApiOperation, RestApi } from '@wirebench/engine';
import { checkArgs } from '../../../src/ops/contract-tools.js';
import { restRequestOf, restToolSchema } from '../../../src/ops/rest-args.js';

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

  it('leaves a query API key out of the query section, and the section when nothing else is left', () => {
    const api = {
      auth: { type: 'api-key', name: 'key', in: 'query', valueRef: 'key' },
    } as unknown as RestApi;
    const operation = {
      method: 'get',
      path: '/pets',
      parameters: [
        { name: 'key', in: 'query', required: true, schema: { type: 'string' } },
        { name: 'limit', in: 'query', schema: { type: 'integer' } },
      ],
    } as unknown as OpenApiOperation;
    expect(restToolSchema(api, operation).schema).toEqual({
      type: 'object',
      properties: {
        query: { type: 'object', properties: { limit: { type: 'integer' } }, additionalProperties: false },
      },
      additionalProperties: false,
    });
    const keyOnly = { ...operation, parameters: [operation.parameters?.[0]] } as unknown as OpenApiOperation;
    expect(restToolSchema(api, keyOnly).schema['properties']).toEqual({});
  });

  it('refuses a caller-supplied value for an API key parameter, so only the configured key is sent', () => {
    const queryApi = { auth: { type: 'api-key', name: 'key', in: 'query', valueRef: 'key' } } as unknown as RestApi;
    const operation = {
      method: 'get',
      path: '/pets',
      parameters: [
        { name: 'key', in: 'query', schema: { type: 'string' } },
        { name: 'X-Key', in: 'header', schema: { type: 'string' } },
        { name: 'limit', in: 'query', schema: { type: 'integer' } },
      ],
    } as unknown as OpenApiOperation;
    const queryTool = restToolSchema(queryApi, operation).schema;
    expect(() => checkArgs(queryTool, { query: { limit: 1 } })).not.toThrow();
    expect(() => checkArgs(queryTool, { query: { key: 'mine' } })).toThrow(/invalid-input|additional|key/i);
    const headerTool = restToolSchema(API, operation).schema;
    expect(() => checkArgs(headerTool, { headers: { 'X-Key': 'mine' } })).toThrow(/X-Key|additional/i);
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

describe('restRequestOf', () => {
  it('fills path rows (simple), query rows (form, exploded) and headers, raw values, and the JSON body', () => {
    const operation = {
      method: 'post',
      path: '/items/{id}',
      parameters: [],
      requestBody: { content: { 'application/vnd.item+json': { schema: { type: 'object' } } } },
    } as unknown as OpenApiOperation;
    const request = restRequestOf(
      operation,
      {
        path: { id: ['a b', 'c'] },
        query: { tag: ['x', 'y'], filter: { size: 2, color: 'red' }, q: 'a&b' },
        headers: { 'X-Trace': 7 },
        body: { name: 'Rex' },
      },
      'createItem (CLI)',
    );
    expect(request).toMatchObject({
      name: 'createItem (CLI)',
      method: 'POST',
      url: '/items/{id}',
      pathParams: [{ name: 'id', value: 'a b,c', enabled: true }],
      query: [
        { name: 'tag', value: 'x', enabled: true },
        { name: 'tag', value: 'y', enabled: true },
        { name: 'size', value: '2', enabled: true },
        { name: 'color', value: 'red', enabled: true },
        { name: 'q', value: 'a&b', enabled: true },
      ],
      headers: [{ name: 'X-Trace', value: '7', enabled: true }],
      body: { kind: 'raw', language: 'json', contentType: 'application/vnd.item+json', text: '{"name":"Rex"}' },
      auth: { type: 'inherit' },
      contract: { method: 'post', path: '/items/{id}' },
      // Encoding is never left to an inherited setting: the escapes below rely on it.
      settings: { encodeUrl: true },
    });
  });

  it('writes an object path value as k=v pairs', () => {
    const operation = { method: 'get', path: '/m/{point}', parameters: [] } as unknown as OpenApiOperation;
    expect(restRequestOf(operation, { path: { point: { x: 1, y: true } } }, 'm').pathParams).toEqual([
      { name: 'point', value: 'x=1,y=true', enabled: true },
    ]);
  });

  it('escapes % in path and query names and values, but not in headers', () => {
    const operation = { method: 'get', path: '/items/{id}', parameters: [] } as unknown as OpenApiOperation;
    const request = restRequestOf(
      operation,
      { path: { id: ['%41', '%2e'] }, query: { filter: { 'k%20': '%20' }, q: '%' }, headers: { 'X-Note': '%41' } },
      'm',
    );
    expect(request.pathParams).toEqual([{ name: 'id', value: '%2541,%252e', enabled: true }]);
    expect(request.query).toEqual([
      { name: 'k%2520', value: '%2520', enabled: true },
      { name: 'q', value: '%25', enabled: true },
    ]);
    expect(request.headers).toEqual([{ name: 'X-Note', value: '%41', enabled: true }]);
  });

  it('sends a non-JSON body as written, and no body when none is given', () => {
    const operation = {
      method: 'put',
      path: '/notes',
      parameters: [],
      requestBody: { content: { 'text/plain': {} } },
    } as unknown as OpenApiOperation;
    expect(restRequestOf(operation, { body: 'hello' }, 'n').body).toEqual({
      kind: 'raw',
      language: 'text',
      contentType: 'text/plain',
      text: 'hello',
    });
    expect(restRequestOf(operation, {}, 'n').body).toEqual({ kind: 'none' });
  });
});
