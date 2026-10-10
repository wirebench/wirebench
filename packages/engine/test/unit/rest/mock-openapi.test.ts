/**
 * A REST mock serves its OpenAPI document (spec §Serving the OpenAPI document): the cached root as JSON
 * or YAML with its servers pointing at the mock, every cached document a `$ref` reaches served under the
 * mock by index, an operation of the API's own never shadowed, and no document location in a reply.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYamlDocument } from 'yaml';
import { createMock } from '../../../src/mock/model.js';
import { startMock } from '../../../src/mock/server.js';
import type { RunningMock } from '../../../src/mock/server.js';
import { openApiReply } from '../../../src/rest/mock-openapi.js';
import { mockProject } from '../mock/fixture.js';
import { tempProjectDir } from '../project/fixture.js';

const ROOT = `openapi: 3.0.3
info: { title: Orders, version: '1' }
servers:
  - url: https://api.example.invalid/v1
paths:
  /orders/{id}:
    servers:
      - url: https://eu.example.invalid/v1
    get:
      parameters:
        - { name: id, in: path, required: true, schema: { type: integer } }
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema: { $ref: 'schemas/order.yaml#/Order' }
`;

const ORDER = `Order:
  type: object
  properties:
    id: { $ref: '../common.json#/Id' }
    note: { $ref: '#/Note' }
Note: { type: string }
`;

const COMMON = `{ "Id": { "type": "integer" } }`;

type Json = Record<string, unknown>;

async function openapiFiles(root = ROOT): Promise<string> {
  const dir = await tempProjectDir();
  await mkdir(join(dir, 'schemas'));
  await writeFile(join(dir, 'openapi.yaml'), root);
  await writeFile(join(dir, 'schemas', 'order.yaml'), ORDER);
  await writeFile(join(dir, 'common.json'), COMMON);
  return pathToFileURL(join(dir, 'openapi.yaml')).href;
}

const running: RunningMock[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((m) => m.stop()));
});

async function start(root?: string): Promise<RunningMock> {
  const mock = createMock('Orders', { containerId: 'A1' }, { id: 'M1', path: '/api' });
  const { dir, project } = await mockProject({ openapi: await openapiFiles(root), mocks: [mock] });
  const started = await startMock({ project, root: dir, mockId: 'M1' });
  running.push(started);
  return started;
}

/** Every `$ref` in `value`. */
function refs(value: unknown): string[] {
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, item]) =>
    key === '$ref' && typeof item === 'string' ? [item] : refs(item),
  );
}

describe('a REST mock serving its OpenAPI document', () => {
  it('serves the root as JSON with its servers at the mock and every referenced document under the mock', async () => {
    const m = await start();
    const reply = await fetch(`${m.url}/openapi.json`);
    expect(reply.status).toBe(200);
    expect(reply.headers.get('content-type')).toBe('application/json');
    const text = await reply.text();
    expect(text).not.toContain('example.invalid');
    const root = JSON.parse(text) as Json;
    expect(root['servers']).toEqual([{ url: m.url }]);
    expect((root['paths'] as Json)['/orders/{id}']).toMatchObject({ servers: [{ url: m.url }] });
    expect(refs(root)).toEqual([`${m.url}/openapi/1.json#/Order`]);

    const order = (await (await fetch(`${m.url}/openapi/1.json`)).json()) as Json;
    expect(refs(order).sort()).toEqual(['#/Note', `${m.url}/openapi/2.json#/Id`]);
    expect(await (await fetch(`${m.url}/openapi/2.json`)).json()).toEqual({ Id: { type: 'integer' } });
  });

  it('serves the same documents as YAML, their references to YAML', async () => {
    const m = await start();
    const reply = await fetch(`${m.url}/openapi.yaml`);
    expect(reply.status).toBe(200);
    expect(reply.headers.get('content-type')).toBe('application/yaml');
    const root = parseYamlDocument(await reply.text()) as Json;
    expect(root['servers']).toEqual([{ url: m.url }]);
    expect(refs(root)).toEqual([`${m.url}/openapi/1.yaml#/Order`]);
    const order = parseYamlDocument(await (await fetch(`${m.url}/openapi/1.yaml`)).text()) as Json;
    expect(refs(order)).toContain(`${m.url}/openapi/2.yaml#/Id`);
  });

  it('serves cached documents by index only, and only to a GET', async () => {
    const m = await start();
    expect((await fetch(`${m.url}/openapi/99.json`)).status).toBe(404);
    expect((await fetch(`${m.url}/openapi/0.json`)).status).toBe(200);
    expect((await fetch(`${m.url}/openapi/..%2F..%2Fetc%2Fpasswd.json`)).status).toBe(404);
    expect((await fetch(`${m.url}/openapi.xml`)).status).toBe(404);
    const post = await fetch(`${m.url}/openapi.json`, { method: 'POST' });
    expect(post.headers.get('content-type')).toBe('application/problem+json');
  });

  it('routes a GET /openapi.json the API itself documents', async () => {
    const own = ROOT.replace(
      'paths:\n',
      "paths:\n  /openapi.json:\n    get:\n      responses: { '200': { description: its own } }\n",
    );
    const m = await start(own);
    const reply = await fetch(`${m.url}/openapi.json`);
    expect(reply.status).toBe(501);
    expect((await fetch(`${m.url}/openapi.yaml`)).status).toBe(200);
  });
});

describe('openApiReply', () => {
  const document = (location: string, text: string) => ({
    location,
    requestedLocation: location,
    bytes: new TextEncoder().encode(text),
    text,
  });

  it('never writes a document location into a reply', () => {
    const secretRoot = 'https://user:hunter22@api.example.invalid/openapi.json?token=s3cr3t';
    const documents = [
      document(
        secretRoot,
        JSON.stringify({
          openapi: '3.1.0',
          paths: {},
          components: { schemas: { A: { $ref: 'a.json?token=s3cr3t' }, B: { $ref: 'https://other.invalid/b.json' } } },
        }),
      ),
      document('https://user:hunter22@api.example.invalid/a.json?token=s3cr3t', '{"type":"string"}'),
    ];
    const reply = openApiReply(documents, 0, 'json', 'http://127.0.0.1:9/api/');
    expect(reply.status).toBe(200);
    expect(reply.body).not.toContain('hunter22');
    expect(reply.body).not.toContain('s3cr3t');
    expect(reply.body).not.toContain('api.example.invalid');
    const schemas = (JSON.parse(reply.body) as { components: { schemas: Json } }).components.schemas;
    expect(schemas).toEqual({
      A: { $ref: 'http://127.0.0.1:9/api/openapi/1.json' },
      B: { $ref: 'https://other.invalid/b.json' },
    });
  });

  it('points a Swagger 2.0 document at the mock with host, basePath and schemes', () => {
    const swagger = document(
      'file:///defs/swagger.json',
      JSON.stringify({ swagger: '2.0', host: 'api.example.invalid', basePath: '/v1', schemes: ['https'], paths: {} }),
    );
    const reply = openApiReply([swagger], 0, 'json', 'http://127.0.0.1:9/mocks/orders');
    expect(JSON.parse(reply.body)).toMatchObject({ host: '127.0.0.1:9', basePath: '/mocks/orders', schemes: ['http'] });
    const atRoot = openApiReply([swagger], 0, 'json', 'http://127.0.0.1:9/');
    expect(JSON.parse(atRoot.body)).toMatchObject({ basePath: '/' });
  });

  it('answers 500, not a hang, for a YAML document that contains itself', () => {
    const reply = openApiReply([document('file:///defs/loop.yaml', 'a: &x\n  b: *x\n')], 0, 'yaml', 'http://h/');
    expect(reply.status).toBe(500);
  });
});
