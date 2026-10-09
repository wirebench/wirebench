/**
 * REST mock services over real HTTP (spec §Validation → REST): routing with 404 and 405, the 400 and
 * 415 refusals as problem+json, report and off modes, match by JSONPath, query, header and path, and
 * generation from examples and schemas.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createMock, createMockOperation, createMockResponse } from '../../../src/mock/model.js';
import type { MockDef, MockValidation } from '../../../src/mock/model.js';
import { startMock } from '../../../src/mock/server.js';
import type { MockExchangeEvent, RunningMock } from '../../../src/mock/server.js';
import { nodeFs } from '../../../src/project/fs.js';
import { restMocking } from '../../../src/rest/mock.js';
import { mockProject } from '../mock/fixture.js';
import { tempProjectDir } from '../project/fixture.js';

const OPENAPI = `openapi: 3.0.3
info: { title: Orders, version: '1' }
paths:
  /orders:
    get:
      operationId: listOrders
      parameters:
        - { name: limit, in: query, schema: { type: integer, maximum: 50 } }
      responses:
        '200':
          description: ok
          content:
            application/json:
              example: [{ id: 1 }]
    post:
      operationId: createOrder
      requestBody:
        required: true
        content:
          application/json:
            schema: { type: object, required: [qty], properties: { qty: { type: integer, minimum: 1 } } }
      responses:
        '201':
          description: created
          content:
            application/json:
              schema:
                type: object
                properties:
                  id: { type: integer, readOnly: true }
                  state: { type: string, enum: [open] }
                  note: { type: string, writeOnly: true }
  /orders/{id}:
    get:
      parameters:
        - { name: id, in: path, required: true, schema: { type: integer } }
      responses:
        '200': { description: ok, content: { application/json: { schema: { type: object } } } }
    delete:
      parameters:
        - { name: id, in: path, required: true, schema: { type: integer } }
      responses:
        '204': { description: gone }
`;

async function openapiFile(): Promise<string> {
  const dir = await tempProjectDir();
  const file = join(dir, 'openapi.yaml');
  await writeFile(file, OPENAPI);
  return pathToFileURL(file).href;
}

function ordersMock(validation: MockValidation = 'reject'): MockDef {
  return createMock(
    'Orders',
    { containerId: 'A1' },
    {
      id: 'M1',
      path: '/api',
      validation,
      operations: [
        createMockOperation('Create', 'post /orders', {
          id: 'O1',
          dispatch: 'match',
          defaultResponseId: 'R1',
          responses: [
            createMockResponse('Bulk', {
              id: 'R2',
              status: 202,
              body: 'json',
              bodyText: '{"bulk":true}',
              match: [
                { from: 'body', language: 'jsonpath', expression: '$.qty', equals: '100' },
                { from: 'header', name: 'x-mode', equals: 'bulk' },
              ],
            }),
            createMockResponse('Created', { id: 'R1', order: 1, status: 201, body: 'json', bodyText: '{"id":1}' }),
          ],
        }),
        createMockOperation('One', 'get /orders/{id}', {
          id: 'O2',
          dispatch: 'match',
          responses: [
            createMockResponse('Seven', {
              id: 'R3',
              body: 'json',
              bodyText: '{"id":7}',
              match: [{ from: 'path', name: 'id', equals: '7' }],
            }),
            createMockResponse('Debug', {
              id: 'R4',
              order: 1,
              body: 'text',
              bodyText: 'debug',
              match: [{ from: 'query', name: 'debug' }],
            }),
          ],
        }),
      ],
    },
  );
}

const running: RunningMock[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((m) => m.stop()));
});

async function start(mock: MockDef, events: MockExchangeEvent[] = []): Promise<RunningMock> {
  const { dir, project } = await mockProject({ openapi: await openapiFile(), mocks: [mock] });
  const started = await startMock({ project, root: dir, mockId: mock.id, onExchange: (e) => events.push(e) });
  running.push(started);
  return started;
}

const json = { 'Content-Type': 'application/json' };

describe('REST mock services', () => {
  it('dispatch by JSONPath and header, by path parameter, and by query', async () => {
    const m = await start(ordersMock());
    expect(await (await fetch(`${m.url}/orders`, { method: 'POST', body: '{"qty":1}', headers: json })).text()).toBe(
      '{"id":1}',
    );
    const bulk = await fetch(`${m.url}/orders`, {
      method: 'POST',
      body: '{"qty":100}',
      headers: { ...json, 'X-Mode': 'bulk' },
    });
    expect(bulk.status).toBe(202);
    expect(bulk.headers.get('content-type')).toBe('application/json');
    expect(await (await fetch(`${m.url}/orders/7`)).text()).toBe('{"id":7}');
    expect(await (await fetch(`${m.url}/orders/8?debug`)).text()).toBe('debug');
    expect((await fetch(`${m.url}/orders/8`)).status).toBe(500);
  });

  it('answer 404 for no path, 405 with Allow for another method, 501 for an operation without stubs', async () => {
    const m = await start(ordersMock());
    expect((await fetch(`${m.url}/nothing`)).status).toBe(404);
    const wrong = await fetch(`${m.url}/orders/1`, { method: 'PATCH' });
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get('allow')).toBe('GET, DELETE');
    const unstubbed = await fetch(`${m.url}/orders`);
    expect(unstubbed.status).toBe(501);
    expect(unstubbed.headers.get('content-type')).toBe('application/problem+json');
  });

  it('refuse a non-conforming request with 400 or 415 as problem+json', async () => {
    const m = await start(ordersMock());
    const bad = await fetch(`${m.url}/orders`, { method: 'POST', body: '{"qty":0}', headers: json });
    expect(bad.status).toBe(400);
    const problem = (await bad.json()) as { type: string; errors: { in: string; path: string }[] };
    expect(problem.type).toBe('urn:wirebench:mock:request-invalid');
    expect(problem.errors[0]).toMatchObject({ in: 'body', path: '/qty' });
    expect(
      (await fetch(`${m.url}/orders`, { method: 'POST', body: 'qty=1', headers: { 'Content-Type': 'text/plain' } }))
        .status,
    ).toBe(415);
    expect((await fetch(`${m.url}/orders/abc`)).status).toBe(400);
  });

  it('report answers anyway with the problems logged; off checks nothing', async () => {
    const events: MockExchangeEvent[] = [];
    const report = await start(ordersMock('report'), events);
    expect((await fetch(`${report.url}/orders`, { method: 'POST', body: '{"qty":0}', headers: json })).status).toBe(
      201,
    );
    expect(events[0]?.problems[0]).toMatchObject({ code: 'mock-request-invalid', in: 'body' });
    const off = await start({ ...ordersMock('off'), id: 'M2' });
    expect(off.url).toContain('/api');
  });

  it('generate a response per operation from its example, its schema, or no content', async () => {
    const { dir, project } = await mockProject({ openapi: await openapiFile() });
    const generated = await restMocking.generate({ project, root: dir, fs: nodeFs, containerId: 'A1' });
    const byKey = Object.fromEntries(
      generated.operations.map((o): [string, (typeof generated.operations)[number]] => [o.key, o]),
    );
    expect(Object.keys(byKey)).toEqual(['get /orders', 'post /orders', 'get /orders/{id}', 'delete /orders/{id}']);
    expect(byKey['get /orders']?.name).toBe('listOrders');
    expect(JSON.parse(byKey['get /orders']?.response.bodyText ?? '')).toEqual([{ id: 1 }]);
    expect(byKey['post /orders']?.response.status).toBe(201);
    // A response stub keeps the read-only `id` a server returns and leaves out the write-only `note`.
    expect(JSON.parse(byKey['post /orders']?.response.bodyText ?? '{}')).toEqual({ id: 0, state: 'open' });
    expect(byKey['delete /orders/{id}']?.response).toMatchObject({ status: 204, body: 'none' });
  });

  it('refuse an API whose definition is not cached', async () => {
    const { dir, project } = await mockProject({ openapi: await openapiFile() });
    await expect(
      restMocking.generate({ project, root: `${dir}-elsewhere`, fs: nodeFs, containerId: 'A1' }),
    ).rejects.toMatchObject({ code: 'mock-definition-missing' });
  });
});
