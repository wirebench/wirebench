import Fastify, { type FastifyRequest } from 'fastify';
import { checkEgress, WirebenchError } from '@wirebench/engine';
import { describe, expect, it, vi } from 'vitest';
import { egressPolicyOf, HOSTED_REFUSED, loadConfig, type ServerConfig } from '../../../src/config.js';
import { main } from '../../../src/main.js';
import type { TenantDirectory } from '../../../src/tenancy/directory.js';
import { hostKey, registerTenantResolution, RELOAD_MS, TenantResolver } from '../../../src/tenancy/resolve.js';
import { scopeOf, type TenantScope } from '../../../src/tenancy/scope.js';
import { operatorPublicUrl, tenantUrl, urlWithoutScope } from '../../../src/tenancy/urls.js';

const ENV = { WIREBENCH_SERVER_DATABASE_URL: 'postgres://u:p@db/x', WIREBENCH_SERVER_PUBLIC_URL: 'https://wb.test' };
const selfHosted = loadConfig(ENV, '0.0.0-test');
const hosted: ServerConfig = { ...selfHosted, mode: 'hosted', appDomain: 'Example.Test' };
const ACME = scopeOf({ id: '00000000-0000-4000-8000-00000000000a', slug: 'acme' });
const DEFAULT = scopeOf({ id: '00000000-0000-4000-8000-000000000001', slug: 'default' });

/** A directory whose hosted list is `scopes`, and whose writes are told through `change()`. */
function fakeDirectory(scopes: TenantScope[]) {
  const listeners: (() => void)[] = [];
  const directory = {
    resolvable: vi.fn(() => Promise.resolve([...scopes])),
    onChange: vi.fn((listener: () => void) => {
      listeners.push(listener);
      return () => listeners.splice(listeners.indexOf(listener), 1);
    }),
    defaultScope: () => DEFAULT,
  };
  return { directory, listeners, change: () => listeners.forEach((listener) => listener()) };
}

describe("the tenant's URL (spec §19.5)", () => {
  it('is the public URL self-hosted, whatever the scope, and https://<slug>.<appDomain> hosted', () => {
    expect(tenantUrl(selfHosted, ACME)).toBe('https://wb.test');
    expect(tenantUrl(hosted, ACME)).toBe('https://acme.example.test');
    expect(tenantUrl(hosted, { tenant: ACME })).toBe('https://acme.example.test');
    expect(() => tenantUrl({ ...hosted, appDomain: '' }, ACME)).toThrow('app domain');
  });

  it('never reads the request in self-hosted mode', () => {
    const request = {
      get tenant(): TenantScope {
        throw new Error('read');
      },
    };
    expect(tenantUrl(selfHosted, request)).toBe('https://wb.test');
    expect(() => tenantUrl(hosted, request)).toThrow('read');
  });

  it('has no unscoped URL in hosted mode, and the operator keeps the configured one', () => {
    expect(urlWithoutScope(selfHosted)).toBe('https://wb.test');
    expect(urlWithoutScope(hosted)).toBeUndefined();
    expect(operatorPublicUrl(hosted)).toBe('https://wb.test');
  });
});

describe('the hosted map', () => {
  it('keys hosts lower-cased, without a port or a trailing dot', () => {
    expect(hostKey('ACME.Example.Test:443')).toBe('acme.example.test');
    expect(hostKey('acme.example.test.')).toBe('acme.example.test');
    expect(hostKey('[::1]:80')).toBe('[::1]:80');
  });

  it('resolves exactly <slug>.<appDomain>, reloads on a directory write, and runs one more read after a busy one', async () => {
    const scopes = [ACME];
    const fake = fakeDirectory(scopes);
    const resolver = new TenantResolver({
      appDomain: 'Example.Test',
      directory: fake.directory,
      log: { warn: vi.fn() },
      setInterval: () => ({}),
      clearInterval: () => undefined,
    });
    await resolver.invalidate();
    expect(resolver.resolve('acme.example.test')).toBe(ACME);
    for (const host of ['example.test', 'x.acme.example.test', 'acme.example.test.evil', 'acme'])
      expect(resolver.resolve(host), host).toBeUndefined();
    resolver.start();
    const beta = scopeOf({ id: '00000000-0000-4000-8000-00000000000b', slug: 'beta' });
    scopes.push(beta);
    fake.directory.resolvable.mockImplementation(() => Promise.resolve([...scopes]));
    const first = resolver.invalidate();
    const second = resolver.invalidate();
    expect(second).toBe(first);
    await first;
    expect(fake.directory.resolvable).toHaveBeenCalledTimes(3);
    expect(resolver.resolve('beta.example.test')).toBe(beta);
    scopes.splice(0);
    fake.change();
    await vi.waitFor(() => {
      expect(resolver.resolve('acme.example.test')).toBeUndefined();
    });
    resolver.stop();
    expect(fake.listeners).toHaveLength(0);
  });

  it('polls every 60 s and keeps the last map when a read fails', async () => {
    let tick: (() => void) | undefined;
    const fake = fakeDirectory([ACME]);
    const warn = vi.fn();
    const cleared = vi.fn();
    const resolver = new TenantResolver({
      appDomain: 'example.test',
      directory: fake.directory,
      log: { warn },
      setInterval: (fn, ms) => {
        expect(ms).toBe(RELOAD_MS);
        tick = fn;
        return {};
      },
      clearInterval: cleared,
    });
    await resolver.invalidate();
    resolver.start();
    fake.directory.resolvable.mockImplementation(() => Promise.reject(new Error('db down')));
    tick!();
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledOnce();
    });
    expect(resolver.resolve('acme.example.test')).toBe(ACME);
    resolver.stop();
    expect(cleared).toHaveBeenCalledOnce();
  });
});

describe('the root hook', () => {
  /** A server whose requests throw when anything reads `Host` or `hostname`. */
  async function serverFor(config: ServerConfig) {
    const app = Fastify();
    app.addHook('onRequest', (request, _reply, done) => {
      Object.defineProperty(request, 'hostname', {
        get: () => {
          throw new WirebenchError('host-read', 'Host was read');
        },
      });
      done();
    });
    const fake = fakeDirectory([ACME]);
    await registerTenantResolution(app, config, fake.directory as unknown as TenantDirectory);
    app.get('/probe', (request: FastifyRequest) => Promise.resolve({ tenantId: request.tenant.tenantId }));
    await app.ready();
    return app;
  }

  it('never reads Host in self-hosted mode', async () => {
    const app = await serverFor(selfHosted);
    const res = await app.inject({ method: 'GET', url: '/probe', headers: { host: 'acme.example.test' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ tenantId: DEFAULT.tenantId });
    await app.close();
  });

  it('reads it in hosted mode, which the probe above would catch', async () => {
    const app = await serverFor(hosted);
    const res = await app.inject({ method: 'GET', url: '/probe', headers: { host: 'acme.example.test' } });
    expect(res.statusCode).toBe(500);
    await app.close();
  });
});

describe('hosted mode is test-only (spec §19.1)', () => {
  const io = () => ({ stdout: { write: vi.fn() }, stderr: { write: vi.fn() } });
  const stderrOf = (stream: { write: ReturnType<typeof vi.fn> }) => stream.write.mock.calls.map(String).join('');

  it.each([[['serve']], [['migrate']], [['migrate', '--check']], [['config', 'check']]])(
    '%j refuses WIREBENCH_SERVER_MODE=hosted',
    async (argv) => {
      const streams = io();
      const code = await main(argv, { ...streams, env: { ...ENV, WIREBENCH_SERVER_MODE: 'hosted' } });
      expect(code).toBe(2);
      expect(stderrOf(streams.stderr)).toContain(`WIREBENCH_SERVER_MODE: ${HOSTED_REFUSED}`);
    },
  );

  it('denies a private address to hosted egress even with private ranges open', () => {
    const open = { ...hosted, egressDenyPrivate: false };
    expect(() => {
      checkEgress('10.0.0.5', '10.0.0.5', egressPolicyOf(open));
    }).toThrow(expect.objectContaining({ code: 'egress-refused' }));
    expect(() => {
      checkEgress('10.0.0.5', '10.0.0.5', egressPolicyOf(selfHosted));
    }).not.toThrow();
  });
});
