/**
 * The apex and the entry in hosted resolution (hosted edition spec §21.3): the apex redirects to the entry, the entry
 * serves only routes marked as its own and gives them no tenant, and a tenant host never reaches an entry route.
 */
import type { IncomingMessage } from 'node:http';
import Fastify, { type FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '../../../src/config.js';
import type { TenantDirectory } from '../../../src/tenancy/directory.js';
import { ENTRY_ROUTE, rawHostOf, registerTenantResolution } from '../../../src/tenancy/resolve.js';
import { scopeOf } from '../../../src/tenancy/scope.js';

const ACME = scopeOf({ id: '00000000-0000-4000-8000-00000000000a', slug: 'acme' });
const DEFAULT = scopeOf({ id: '00000000-0000-4000-8000-000000000001', slug: 'default' });

const hosted = { mode: 'hosted', appDomain: 'app.test', siteDomain: 'site.test', trustProxy: false } as ServerConfig;

function directory(): TenantDirectory {
  return {
    resolvable: vi.fn(() => Promise.resolve([ACME])),
    onChange: vi.fn(() => () => undefined),
    defaultScope: () => DEFAULT,
  } as unknown as TenantDirectory;
}

async function serverFor(config: ServerConfig, trustProxy = false) {
  const app = Fastify({ trustProxy });
  await registerTenantResolution(app, { ...config, trustProxy }, directory());
  app.get('/', ENTRY_ROUTE, () => Promise.resolve('entry'));
  app.get('/tenant-read', ENTRY_ROUTE, (request: FastifyRequest) => request.tenant.tenantId);
  app.get('/', (request: FastifyRequest) => Promise.resolve(`tenant ${request.tenant.slug}`));
  app.get('/api/v1/probe', (request: FastifyRequest) => Promise.resolve(request.tenant.slug));
  app.get('/healthz', () => Promise.resolve('ok'));
  await app.ready();
  return app;
}

describe('the apex', () => {
  it('redirects to the entry, dropping the path and the query', async () => {
    const app = await serverFor(hosted);
    for (const url of ['/', '/sign-in?next=/x', '/api/v1/probe']) {
      const res = await app.inject({ method: 'GET', url, headers: { host: 'App.Test:443' } });
      expect(res.statusCode, url).toBe(308);
      expect(res.headers.location).toBe('https://app.app.test/');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toBe('');
    }
    await app.close();
  });
});

describe('the entry', () => {
  it('serves its own routes, whatever the case or the port', async () => {
    const app = await serverFor(hosted);
    const res = await app.inject({ method: 'GET', url: '/', headers: { host: 'APP.app.test:443' } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('entry');
    await app.close();
  });

  it('answers 404, empty and no-store, for any route that is not its own', async () => {
    const app = await serverFor(hosted);
    for (const url of ['/api/v1/probe', '/missing']) {
      const res = await app.inject({ method: 'GET', url, headers: { host: 'app.app.test' } });
      expect(res.statusCode, url).toBe(404);
      expect(res.body).toBe('');
      expect(res.headers['cache-control']).toBe('no-store');
    }
    await app.close();
  });

  it('gives its routes no tenant', async () => {
    const app = await serverFor(hosted);
    const res = await app.inject({ method: 'GET', url: '/tenant-read', headers: { host: 'app.app.test' } });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ code: 'tenancy-unresolved' });
    await app.close();
  });

  it('is never reached from a tenant host, where the same path is the tenant’s', async () => {
    const app = await serverFor(hosted);
    const res = await app.inject({ method: 'GET', url: '/', headers: { host: 'acme.app.test' } });
    expect(res.body).toBe('tenant acme');
    const read = await app.inject({ method: 'GET', url: '/tenant-read', headers: { host: 'acme.app.test' } });
    expect(read.statusCode).toBe(404);
    await app.close();
  });

  it('takes X-Forwarded-Host only behind a trusted proxy', async () => {
    const headers = { host: 'acme.app.test', 'x-forwarded-host': 'app.app.test' };
    const untrusted = await serverFor(hosted);
    expect((await untrusted.inject({ method: 'GET', url: '/', headers })).body).toBe('tenant acme');
    await untrusted.close();
    const trusted = await serverFor(hosted, true);
    expect((await trusted.inject({ method: 'GET', url: '/', headers })).body).toBe('entry');
    await trusted.close();
  });

  it('leaves /healthz unscoped on the apex and the entry', async () => {
    const app = await serverFor(hosted);
    for (const host of ['app.test', 'app.app.test']) {
      const res = await app.inject({ method: 'GET', url: '/healthz', headers: { host } });
      expect(res.statusCode, host).toBe(200);
    }
    await app.close();
  });
});

describe('rawHostOf', () => {
  const req = (headers: Record<string, string>): IncomingMessage => ({ headers }) as unknown as IncomingMessage;

  it('reads Host, keyed like the tenant map', () => {
    expect(rawHostOf(req({ host: 'APP.app.test:8443' }), false)).toBe('app.app.test');
    expect(rawHostOf(req({ host: 'app.app.test.' }), false)).toBe('app.app.test');
  });

  it('takes the last X-Forwarded-Host entry, behind a trusted proxy only', () => {
    const headers = { host: 'internal:8080', 'x-forwarded-host': 'acme.app.test, app.app.test' };
    expect(rawHostOf(req(headers), true)).toBe('app.app.test');
    expect(rawHostOf(req(headers), false)).toBe('internal');
  });

  it('leaves a non-numeric port in, so the name never matches the entry', () => {
    expect(rawHostOf(req({ host: 'app.app.test:abc' }), false)).toBe('app.app.test:abc');
  });
});

describe('the apex behind a trusted proxy', () => {
  it('redirects when X-Forwarded-Host names it', async () => {
    const app = await serverFor(hosted, true);
    const res = await app.inject({
      method: 'GET',
      url: '/',
      headers: { host: 'internal', 'x-forwarded-host': 'app.test' },
    });
    expect(res.statusCode).toBe(308);
    await app.close();
  });
});
