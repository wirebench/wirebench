import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SERVER_API_VERSION } from '@wirebench/engine';
import { ServerClient } from '../../../../apps/desktop/src/main/server-client.js';
import type { ServerModule } from '../../src/context.js';
import { buildServer } from '../../src/server.js';
import { testContext } from '../helpers/context.js';
import { injectSend } from '../helpers/inject-send.js';

/** Two routes that show back what arrived, with headers a real response can carry more than once. */
const echo: ServerModule = {
  name: 'server-sync',
  register: async (app) => {
    app.get('/echo', (request, reply) => {
      void reply.header('set-cookie', ['a=1', 'b=2']);
      return Promise.resolve({ url: request.url, authorization: request.headers.authorization ?? null });
    });
    app.post('/echo', (request, reply) => {
      void reply.code(201);
      return Promise.resolve({ body: request.body, type: request.headers['content-type'] ?? null });
    });
    await Promise.resolve();
  },
};

let dataDir: string;
let app: FastifyInstance;
beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'wbs-inject-'));
  app = await buildServer(await testContext({ dataDir }), { modules: [echo] });
});
afterEach(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const decode = (bytes: Uint8Array): unknown => JSON.parse(new TextDecoder().decode(bytes));

describe('injectSend', () => {
  it('carries method, path, query, headers and body in; status, lower-cased headers and bytes out', async () => {
    const send = injectSend(app);

    const got = await send({
      url: 'https://wirebench.test/api/v1/echo?from=abc',
      method: 'GET',
      headers: { accept: 'application/json', authorization: 'Bearer t0k' },
      timeoutMs: 1_000,
      followRedirects: false,
    });
    expect(got.status).toBe(200);
    expect(got.headers['content-type']).toMatch(/^application\/json/);
    expect(got.headers['x-request-id']).toEqual(expect.any(String));
    // As `sendHttp` records them: the first `set-cookie` in `headers`, every one in `rawHeaders`.
    expect(got.headers['set-cookie']).toBe('a=1');
    expect(got.rawHeaders.filter(([name]) => name === 'set-cookie')).toEqual([
      ['set-cookie', 'a=1'],
      ['set-cookie', 'b=2'],
    ]);
    expect(decode(got.body)).toEqual({ url: '/api/v1/echo?from=abc', authorization: 'Bearer t0k' });
    expect(got.rawBody).toEqual(got.body);

    const posted = await send({
      url: 'https://wirebench.test/api/v1/echo',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode('{"parent":null}'),
      timeoutMs: 1_000,
      followRedirects: false,
    });
    expect(posted.status).toBe(201);
    expect(decode(posted.body)).toEqual({ body: { parent: null }, type: 'application/json' });
  });

  it("lets the desktop's ServerClient read answers and problems exactly as over the network", async () => {
    const client = new ServerClient({ send: injectSend(app) });

    expect((await client.meta('https://wirebench.test')).apiVersion).toBe(SERVER_API_VERSION);
    // No sync module in this server: the not-found problem reaches the client as a WirebenchError.
    await expect(client.syncHead('https://wirebench.test', 't0k', '01J8Z0000000000000000000AB')).rejects.toMatchObject({
      code: 'not-found',
      details: { status: 404 },
    });
  });
});
