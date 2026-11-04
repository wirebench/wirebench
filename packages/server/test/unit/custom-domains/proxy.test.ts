/**
 * The proxy listener (hosted edition spec §23.4): its configuration, the Traefik payload and its router names, the
 * bearer check and what it logs. The tenants are a fake `forEachTenant` here; the integration test reads the real
 * `tenant_hosts`. Every name is under `.test`.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, parseHostPort, type ServerConfig } from '../../../src/config.js';
import {
  buildProxyServer,
  PROXY_ROUTE,
  proxyListenerOf,
  readProxyToken,
  routerName,
  traefikPayload,
  type ProxyTenancy,
} from '../../../src/custom-domains/proxy.js';
import type { TenantScope } from '../../../src/tenancy/scope.js';

const required = {
  WIREBENCH_SERVER_DATABASE_URL: 'postgres://u:p@db/wirebench',
  WIREBENCH_SERVER_PUBLIC_URL: 'https://wirebench.example.test',
};
const TOKEN = 'proxy-token-0123456789abcdefghijklmnopqrstuv';

function problemsOf(env: Record<string, string>): readonly string[] {
  try {
    loadConfig({ ...required, ...env }, '0.0.0');
  } catch (error) {
    if (error instanceof ConfigError) return error.problems.map((problem) => problem.variable);
    throw error;
  }
  return [];
}

describe('the proxy listener’s configuration', () => {
  it('reads the listener and the token file', () => {
    const config = loadConfig(
      {
        ...required,
        WIREBENCH_SERVER_PROXY_LISTEN: '0.0.0.0:8081',
        WIREBENCH_SERVER_PROXY_TOKEN_FILE: '/run/secrets/proxy_token',
      },
      '0.0.0',
    );
    expect(config.proxyListen).toBe('0.0.0.0:8081');
    expect(config.proxyTokenFile).toBe('/run/secrets/proxy_token');
  });

  it('leaves both unset by default: no listener', () => {
    const config = loadConfig(required, '0.0.0');
    expect(config.proxyListen).toBeUndefined();
    expect(config.proxyTokenFile).toBeUndefined();
  });

  it('needs the token file when the listener is set', () => {
    expect(problemsOf({ WIREBENCH_SERVER_PROXY_LISTEN: '0.0.0.0:8081' })).toEqual([
      'WIREBENCH_SERVER_PROXY_TOKEN_FILE',
    ]);
  });

  it.each(['8081', 'server', ':8081', 'server:0', 'server:65536', 'http://server:8081', '[server]:8081', 'a b:1'])(
    'refuses %s as the listener',
    (value) => {
      expect(problemsOf({ WIREBENCH_SERVER_PROXY_LISTEN: value, WIREBENCH_SERVER_PROXY_TOKEN_FILE: '/t' })).toEqual([
        'WIREBENCH_SERVER_PROXY_LISTEN',
      ]);
    },
  );

  it('splits host:port, IPv6 in brackets', () => {
    expect(parseHostPort('0.0.0.0:8081')).toEqual({ host: '0.0.0.0', port: 8081 });
    expect(parseHostPort('traefik:443')).toEqual({ host: 'traefik', port: 443 });
    expect(parseHostPort('[::1]:8081')).toEqual({ host: '::1', port: 8081 });
  });

  it('listens in hosted mode only, and only when the listener is set', () => {
    const base = loadConfig(
      { ...required, WIREBENCH_SERVER_PROXY_LISTEN: '127.0.0.1:8081', WIREBENCH_SERVER_PROXY_TOKEN_FILE: '/t' },
      '0.0.0',
    );
    const hosted: ServerConfig = { ...base, mode: 'hosted', appDomain: 'app.test', siteDomain: 'site.test' };
    expect(proxyListenerOf(base)).toBeUndefined();
    expect(proxyListenerOf(hosted)).toEqual({ host: '127.0.0.1', port: 8081, tokenFile: '/t' });
    const { proxyListen: _dropped, ...unset } = hosted;
    void _dropped;
    expect(proxyListenerOf(unset)).toBeUndefined();
  });
});

describe('the token file', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('is read without its trailing newline', async () => {
    dir = await mkdtemp(join(tmpdir(), 'wb-proxy-'));
    await writeFile(join(dir, 'token'), `${TOKEN}\n`);
    expect(await readProxyToken(join(dir, 'token'))).toBe(TOKEN);
  });

  it('refuses an empty file and a missing one, without the file’s content', async () => {
    dir = await mkdtemp(join(tmpdir(), 'wb-proxy-'));
    await writeFile(join(dir, 'empty'), '\n');
    await expect(readProxyToken(join(dir, 'empty'))).rejects.toThrow(/WIREBENCH_SERVER_PROXY_TOKEN_FILE.*empty/);
    await expect(readProxyToken(join(dir, 'missing'))).rejects.toThrow(/WIREBENCH_SERVER_PROXY_TOKEN_FILE/);
  });
});

describe('the Traefik payload', () => {
  it('names each router custom- and the first 16 hex of the host’s SHA-256', () => {
    const hex = createHash('sha256').update('app.customer.test').digest('hex').slice(0, 16);
    expect(routerName('app.customer.test')).toBe(`custom-${hex}`);
    expect(routerName('app.customer.test')).toMatch(/^custom-[0-9a-f]{16}$/);
  });

  it('is one router per name, on websecure, to the file provider’s service, with HSTS and the HTTP-01 resolver', () => {
    expect(traefikPayload(['app.customer.test', 'b.customer.test'])).toEqual({
      http: {
        routers: {
          [routerName('app.customer.test')]: {
            rule: 'Host(`app.customer.test`)',
            entryPoints: ['websecure'],
            service: 'wirebench@file',
            middlewares: ['hsts@file'],
            tls: { certResolver: 'le-http' },
          },
          [routerName('b.customer.test')]: {
            rule: 'Host(`b.customer.test`)',
            entryPoints: ['websecure'],
            service: 'wirebench@file',
            middlewares: ['hsts@file'],
            tls: { certResolver: 'le-http' },
          },
        },
      },
    });
  });

  it('is an empty router map with no names, which Traefik applies (an absent map it would skip)', () => {
    expect(traefikPayload([])).toEqual({ http: { routers: {} } });
  });
});

/** Two tenants' held names, as each tenant's own unit answers them; `failing` makes that tenant's unit throw. */
function fakeTenancy(hosts: Record<string, readonly string[]>, failing = new Set<string>()): ProxyTenancy {
  return {
    forEachTenant: async (_job, fn) => {
      const failed: string[] = [];
      let served = 0;
      for (const [tenantId, names] of Object.entries(hosts)) {
        const scope = { tenantId, slug: tenantId } as unknown as TenantScope;
        const tx = {
          scope,
          query: (sql: string, params: readonly unknown[]) => {
            if (failing.has(tenantId)) return Promise.reject(new Error('database gone'));
            expect(sql).toMatch(/from tenant_hosts where tenant_id = \$1/);
            expect(params).toEqual([tenantId]);
            return Promise.resolve({ rows: names.map((host) => ({ host })), rowCount: names.length });
          },
        };
        try {
          await fn(tx as never, scope);
          served++;
        } catch {
          failed.push(tenantId);
        }
      }
      return { served, failed };
    },
    reachable: () => Promise.resolve(),
  };
}

describe('the proxy listener', () => {
  const lines: string[] = [];
  const logger = () => {
    lines.length = 0;
    const app = Fastify({
      logger: {
        level: 'trace',
        stream: new Writable({
          write(chunk: Buffer, _encoding, done) {
            lines.push(chunk.toString());
            done();
          },
        }),
      },
    });
    return app.log;
  };
  const server = (tenancy: ProxyTenancy) => buildProxyServer({ tenancy, token: TOKEN, log: logger(), cacheMs: 0 });
  const auth = { authorization: `Bearer ${TOKEN}` };

  it('answers 401 without the token, with a wrong one, and with the token under another scheme', async () => {
    const app = server(fakeTenancy({ a: ['app.customer.test'] }));
    for (const headers of [
      {},
      { authorization: `Bearer ${TOKEN}x` },
      { authorization: 'Bearer ' },
      { authorization: TOKEN },
      { authorization: `Basic ${TOKEN}` },
    ]) {
      const response = await app.inject({ method: 'GET', url: PROXY_ROUTE, headers });
      expect(response.statusCode, JSON.stringify(headers)).toBe(401);
      expect(response.body).not.toContain('customer.test');
    }
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(401);
    await app.close();
  });

  it('answers every tenant’s held names with the token, no-store', async () => {
    const app = server(fakeTenancy({ a: ['app.customer.test'], b: [], c: ['c.customer.test'] }));
    const response = await app.inject({ method: 'GET', url: PROXY_ROUTE, headers: auth });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual(traefikPayload(['app.customer.test', 'c.customer.test']));
    await app.close();
  });

  it('answers 503 when a tenant could not be read, so Traefik keeps the routers it has', async () => {
    const app = server(fakeTenancy({ a: ['app.customer.test'], b: ['b.customer.test'] }, new Set(['b'])));
    const response = await app.inject({ method: 'GET', url: PROXY_ROUTE, headers: auth });
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain('customer.test');
    await app.close();
  });

  it('serves /healthz with the token, and nothing else', async () => {
    const app = server(fakeTenancy({}));
    expect((await app.inject({ method: 'GET', url: '/healthz', headers: auth })).json()).toEqual({ status: 'ok' });
    for (const url of ['/', '/api/v1/meta', '/readyz', `${PROXY_ROUTE}/x`]) {
      expect((await app.inject({ method: 'GET', url, headers: auth })).statusCode, url).toBe(404);
    }
    expect((await app.inject({ method: 'POST', url: PROXY_ROUTE, headers: auth })).statusCode).toBe(404);
    await app.close();
  });

  it('never logs the token', async () => {
    const app = server(fakeTenancy({ a: ['app.customer.test'] }, new Set(['a'])));
    await app.inject({ method: 'GET', url: PROXY_ROUTE, headers: auth });
    await app.inject({ method: 'GET', url: PROXY_ROUTE, headers: { authorization: `Bearer ${TOKEN}-wrong` } });
    await app.inject({ method: 'GET', url: `/nowhere?token=${TOKEN}`, headers: auth });
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).not.toContain(TOKEN);
    await app.close();
  });

  it('reads the tenants once for polls that arrive together, and again once the cache is stale', async () => {
    let reads = 0;
    const base = fakeTenancy({ a: ['app.customer.test'] });
    const counted: ProxyTenancy = {
      ...base,
      forEachTenant: (job, fn, log) => {
        reads++;
        return base.forEachTenant(job, fn, log);
      },
    };
    let now = 0;
    const app = buildProxyServer({ tenancy: counted, token: TOKEN, log: logger(), cacheMs: 2_000, now: () => now });
    await Promise.all([1, 2, 3].map(() => app.inject({ method: 'GET', url: PROXY_ROUTE, headers: auth })));
    expect(reads).toBe(1);
    now = 1_999;
    await app.inject({ method: 'GET', url: PROXY_ROUTE, headers: auth });
    expect(reads).toBe(1);
    now = 2_000;
    await app.inject({ method: 'GET', url: PROXY_ROUTE, headers: auth });
    expect(reads).toBe(2);
    await app.close();
  });
});
