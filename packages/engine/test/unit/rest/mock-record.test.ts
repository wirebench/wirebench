/**
 * Record, save, load, replay (#60, spec §Testing): traffic through the recording proxy to a real
 * upstream becomes response files of a REST mock, and the mock started from the reloaded project
 * answers with what was recorded, in the order it was recorded.
 */
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createMock } from '../../../src/mock/model.js';
import { startRecorder } from '../../../src/mock/record.js';
import { addRecordedStubs } from '../../../src/mock/record-stubs.js';
import { startMock } from '../../../src/mock/server.js';
import { loadProject } from '../../../src/project/load.js';
import { saveProject } from '../../../src/project/save.js';
import { mockProject } from '../mock/fixture.js';
import { tempProjectDir } from '../project/fixture.js';

const OPENAPI = `openapi: 3.0.3
info: { title: Orders, version: '1' }
paths:
  /orders:
    get:
      responses: { '200': { description: ok, content: { application/json: { schema: { type: array } } } } }
    post:
      requestBody:
        content: { application/json: { schema: { type: object } } }
      responses: { '201': { description: created } }
`;

const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(stops.splice(0).map((stop) => stop()));
});

async function upstream(): Promise<string> {
  let gets = 0;
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.method === 'POST') {
        res.writeHead(201, { 'Content-Type': 'application/json', 'Set-Cookie': 'session=live' });
        res.end('{"id":9,"access_token":"live-token"}');
        return;
      }
      gets += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(`[{"id":${String(gets)}}]`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  stops.push(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  return `http://127.0.0.1:${String(typeof address === 'object' && address !== null ? address.port : 0)}/v1`;
}

describe('record then replay a REST mock', () => {
  it('saves masked stubs that the mock serves in recorded order', async () => {
    const definition = join(await tempProjectDir(), 'openapi.yaml');
    await writeFile(definition, OPENAPI);
    const empty = createMock('Orders', { containerId: 'A1' }, { id: 'M1', slug: 'orders', path: '/api' });
    const { dir, project } = await mockProject({ openapi: pathToFileURL(definition).href, mocks: [empty] });

    const recorder = await startRecorder({ project, root: dir, mockId: 'M1', target: await upstream(), port: 0 });
    stops.push(() => recorder.stop());
    expect(await (await fetch(`${recorder.url}/orders`)).text()).toBe('[{"id":1}]');
    expect(await (await fetch(`${recorder.url}/orders`)).text()).toBe('[{"id":2}]');
    const created = await fetch(`${recorder.url}/orders`, {
      method: 'POST',
      body: '{}',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(created.headers.get('set-cookie')).toBe('session=live');

    const added = addRecordedStubs(empty, recorder.recordings());
    expect(added.added).toBe(3);
    await saveProject({ ...project, mocks: [added.mock] }, dir);

    const reloaded = (await loadProject(dir)).project;
    const operations = reloaded.mocks[0]?.operations ?? [];
    expect(operations.map((operation) => operation.operation).sort()).toEqual(['get /orders', 'post /orders']);
    const post = operations.find((operation) => operation.operation === 'post /orders');
    expect(post?.responses[0]?.bodyText).not.toContain('live-token');
    expect(post?.responses[0]?.headers).toContainEqual({ name: 'set-cookie', value: '<redacted>' });

    const mock = await startMock({ project: reloaded, root: dir, mockId: 'M1', port: 0 });
    stops.push(() => mock.stop());
    expect(await (await fetch(`${mock.url}/orders`)).text()).toBe('[{"id":1}]');
    expect(await (await fetch(`${mock.url}/orders`)).text()).toBe('[{"id":2}]');
    const replayed = await fetch(`${mock.url}/orders`, {
      method: 'POST',
      body: '{}',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(replayed.status).toBe(201);
    expect(await replayed.json()).toEqual({ id: 9, access_token: '<redacted>' });
  });
});
