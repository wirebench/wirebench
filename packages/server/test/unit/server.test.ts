import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { problem } from '../../src/problem.js';
import { jsonSchema } from '../../src/schema.js';
import { buildServer } from '../../src/server.js';
import { fakeDatabase, testContext } from '../helpers/context.js';

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'wbs-'));
});
afterEach(() => {
  chmodSync(dataDir, 0o700);
  rmSync(dataDir, { recursive: true, force: true });
});

describe('buildServer', () => {
  it('serves a green /healthz when every check passes', async () => {
    const app = await buildServer(await testContext({ dataDir }), { modules: [] });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', checks: { database: 'ok', dataDir: 'ok', git: 'ok' } });
    await app.close();
  });

  it('reports 503 with the failing check by name and nothing else', async () => {
    const app = await buildServer(await testContext({ dataDir, db: fakeDatabase({ failing: true }) }), { modules: [] });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'failed', checks: { database: 'failed', dataDir: 'ok', git: 'ok' } });
    expect(res.body).not.toContain('refused');
    await app.close();
  });

  // On Windows a directory's read-only attribute does not stop writes into it and access(W_OK)
  // always succeeds for directories, so there is no unwritable data dir to report.
  it.skipIf(process.platform === 'win32')('reports an unwritable data dir', async () => {
    chmodSync(dataDir, 0o500);
    const app = await buildServer(await testContext({ dataDir }), { modules: [] });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.json<{ checks: { dataDir: string } }>().checks.dataDir).toBe(process.getuid?.() === 0 ? 'ok' : 'failed');
    await app.close();
  });

  it('serves /api/v1/meta with empty auth and capabilities', async () => {
    const app = await buildServer(await testContext({ dataDir }), { modules: [] });
    const res = await app.inject({ method: 'GET', url: '/api/v1/meta' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      name: 'wirebench-server',
      version: '0.0.0-test',
      apiVersion: 1,
      publicUrl: 'https://wirebench.test',
      auth: { local: false, oidc: false },
      capabilities: [],
    });
    await app.close();
  });

  it('lets a module contribute meta and routes under /api/v1', async () => {
    const app = await buildServer(await testContext({ dataDir }), {
      modules: [
        {
          name: 'identity',
          // eslint-disable-next-line @typescript-eslint/require-await -- ServerModule.register is async; this one has no await
          register: async (instance, context) => {
            context.meta.setAuth({ local: true });
            context.meta.addCapability('probe');
            // eslint-disable-next-line @typescript-eslint/require-await -- route handler has no await, just returns
            instance.get('/probe', async () => ({ ok: true }));
          },
        },
      ],
    });
    expect((await app.inject({ method: 'GET', url: '/api/v1/meta' })).json()).toMatchObject({
      auth: { local: true, oidc: false },
      capabilities: ['probe'],
    });
    expect((await app.inject({ method: 'GET', url: '/api/v1/probe' })).json()).toEqual({ ok: true });
    await app.close();
  });

  it('answers unknown routes, thrown problems and unknown errors as problems', async () => {
    const app = await buildServer(await testContext({ dataDir }), {
      modules: [
        {
          name: 'identity',
          // eslint-disable-next-line @typescript-eslint/require-await -- ServerModule.register is async; this one has no await
          register: async (instance) => {
            // eslint-disable-next-line @typescript-eslint/require-await -- route handler only throws, no await
            instance.get('/boom', async () => {
              throw problem('server-boom', 'boom', 418);
            });
            // eslint-disable-next-line @typescript-eslint/require-await -- route handler only throws, no await
            instance.get('/crash', async () => {
              throw new Error('secret detail');
            });
          },
        },
      ],
    });
    const missing = await app.inject({ method: 'GET', url: '/nope?secret=qs-s3cret' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ code: 'not-found', message: 'No route for GET /nope' });
    const boom = await app.inject({ method: 'GET', url: '/api/v1/boom' });
    expect(boom.statusCode).toBe(418);
    expect(boom.json()).toEqual({ code: 'server-boom', message: 'boom' });
    const crash = await app.inject({ method: 'GET', url: '/api/v1/crash' });
    expect(crash.statusCode).toBe(500);
    expect(crash.json()).toEqual({ code: 'internal', message: 'Internal error' });
    await app.close();
  });

  it('refuses a body over the configured limit and issues its own request id', async () => {
    const ctx = await testContext({ dataDir });
    const app = await buildServer(
      { ...ctx, config: { ...ctx.config, bodyLimitMb: 1 } },
      {
        modules: [
          {
            name: 'identity',
            // eslint-disable-next-line @typescript-eslint/require-await -- ServerModule.register is async; this one has no await
            register: async (i) => {
              // eslint-disable-next-line @typescript-eslint/require-await -- route handler has no await, just echoes the body
              i.post('/echo', async (req) => req.body);
            },
          },
        ],
      },
    );
    const big = await app.inject({ method: 'POST', url: '/api/v1/echo', payload: { x: 'y'.repeat(1_100_000) } });
    expect(big.statusCode).toBe(413);
    expect(big.json<{ code: string }>().code).toBe('request-too-large');
    const small = await app.inject({ method: 'GET', url: '/healthz', headers: { 'x-request-id': 'abc' } });
    expect(small.headers['x-request-id']).toBeDefined();
    expect(small.headers['x-request-id']).not.toBe('abc'); // trustProxy is off, so incoming ids are ignored
    await app.close();
  });

  it('compiles a request body schema and rejects a body that fails it as invalid-request', async () => {
    const bodySchema = z.object({ name: z.string() });
    const app = await buildServer(await testContext({ dataDir }), {
      modules: [
        {
          name: 'identity',
          // eslint-disable-next-line @typescript-eslint/require-await -- ServerModule.register is async; this one has no await
          register: async (i) => {
            // registering this route is the regression check: a draft 2020-12 schema makes
            // app.ready() (inside buildServer) throw before this test body ever runs.
            i.post(
              '/greet',
              { schema: { body: jsonSchema(bodySchema, { io: 'input' }) } },
              // eslint-disable-next-line @typescript-eslint/require-await -- route handler has no await, just returns
              async (req) => ({ hello: (req.body as { name: string }).name }),
            );
          },
        },
      ],
    });
    const ok = await app.inject({ method: 'POST', url: '/api/v1/greet', payload: { name: 'Ada' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ hello: 'Ada' });

    const bad = await app.inject({ method: 'POST', url: '/api/v1/greet', payload: {} });
    expect(bad.statusCode).toBe(400);
    expect(bad.json<{ code: string; message: string; issues: { path: string; message: string }[] }>()).toMatchObject({
      code: 'invalid-request',
      issues: [{ path: 'name' }],
    });
    await app.close();
  });

  it('maps malformed JSON and an unsupported content type to problems, not internal errors', async () => {
    const app = await buildServer(await testContext({ dataDir }), {
      modules: [
        {
          name: 'identity',
          // eslint-disable-next-line @typescript-eslint/require-await -- ServerModule.register is async; this one has no await
          register: async (i) => {
            // eslint-disable-next-line @typescript-eslint/require-await -- route handler has no await, just echoes
            i.post('/echo', async (req) => req.body);
          },
        },
      ],
    });

    const badJson = await app.inject({
      method: 'POST',
      url: '/api/v1/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(badJson.statusCode).toBe(400);
    expect(badJson.json()).toEqual({ code: 'bad-request', message: 'The request could not be processed.' });

    const badMediaType = await app.inject({
      method: 'POST',
      url: '/api/v1/echo',
      headers: { 'content-type': 'application/x-not-a-real-type' },
      payload: 'whatever',
    });
    expect(badMediaType.statusCode).toBe(415);
    expect(badMediaType.json()).toEqual({ code: 'bad-request', message: 'The request could not be processed.' });

    await app.close();
  });

  it('lets a hook one module adds reach the routes of modules registered after it, inside /api/v1 only', async () => {
    const app = await buildServer(await testContext({ dataDir }), {
      modules: [
        {
          name: 'identity',
          // eslint-disable-next-line @typescript-eslint/require-await -- ServerModule.register is async; this one has no await
          register: async (instance) => {
            instance.decorateRequest('caller', null);
            instance.addHook('onRequest', async (request, reply) => {
              (request as unknown as { caller: string | null }).caller = 'ada';
              void reply.header('x-probe-hook', 'seen');
            });
          },
        },
        {
          name: 'teams-access',
          // eslint-disable-next-line @typescript-eslint/require-await -- ServerModule.register is async; this one has no await
          register: async (instance) => {
            // eslint-disable-next-line @typescript-eslint/require-await -- route handler has no await, just returns
            instance.get('/who', async (request) => ({
              caller: (request as unknown as { caller?: string | null }).caller ?? null,
            }));
          },
        },
      ],
    });
    const who = await app.inject({ method: 'GET', url: '/api/v1/who' });
    expect(who.json()).toEqual({ caller: 'ada' });
    expect(who.headers['x-probe-hook']).toBe('seen');
    const health = await app.inject({ method: 'GET', url: '/healthz' });
    expect(health.statusCode).toBe(200);
    expect(health.headers['x-probe-hook']).toBeUndefined();
    await app.close();
  });

  it('never logs a top-level password, a nested token or a query-string secret', async () => {
    const lines: string[] = [];
    const logStream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        lines.push(chunk.toString('utf-8'));
        callback();
      },
    });
    const ctx = await testContext({ dataDir });
    const app = await buildServer(
      { ...ctx, config: { ...ctx.config, logLevel: 'info' } },
      {
        logStream,
        modules: [
          {
            name: 'identity',
            // eslint-disable-next-line @typescript-eslint/require-await -- ServerModule.register is async; this one has no await
            register: async (i) => {
              // eslint-disable-next-line @typescript-eslint/require-await -- route handler has no await, just logs
              i.get('/lookup', async (request) => {
                request.log.info({ password: 'hunter2', nested: { token: 'tok-n3sted' } }, 'probe');
                return { ok: true };
              });
            },
          },
        ],
      },
    );
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/lookup?secret=qs-s3cret',
      headers: { authorization: 'Bearer hdr-t0ken' },
    });
    expect(res.statusCode).toBe(200);
    await app.inject({ method: 'GET', url: '/nope?token=qs-t0ken' });
    await app.close();
    const text = lines.join('');
    expect(text).toContain('"msg":"probe"');
    expect(text).toContain('"url":"/api/v1/lookup"');
    expect(text).toContain('[redacted]');
    for (const secret of ['hunter2', 'tok-n3sted', 'qs-s3cret', 'qs-t0ken', 'hdr-t0ken']) {
      expect(text).not.toContain(secret);
    }
  });
});
