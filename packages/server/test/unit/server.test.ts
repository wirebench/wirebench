import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { problem } from '../../src/problem.js';
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

  it('reports an unwritable data dir', async () => {
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
    const missing = await app.inject({ method: 'GET', url: '/nope' });
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
});
