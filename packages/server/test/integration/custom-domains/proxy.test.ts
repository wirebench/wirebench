/**
 * The proxy listener over the test database (hosted edition spec §23.4): a real listener on loopback, polled as
 * Traefik polls it. Its payload is every tenant's held names, each read in that tenant's own unit, and only those:
 * a `verified`, `active` or `failing` claim's name, never a pending, lapsed or removed one. Nothing of it is on the
 * public listener. Every name is under `.test`.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyBaseLogger } from 'fastify';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import type { ServerConfig } from '../../../src/config.js';
import {
  PROXY_ROUTE,
  startProxyListener,
  traefikPayload,
  type ProxyListener,
} from '../../../src/custom-domains/proxy.js';
import { claim, hold, record, release, removeClaim } from '../../../src/custom-domains/repo.js';
import type { DomainState } from '../../../src/custom-domains/states.js';
import { TenantAdmin } from '../../../src/tenancy/directory.js';
import { createTenancy, directoryOf, type Tenancy } from '../../../src/tenancy/tenancy.js';
import type { TenantDb } from '../../../src/tenancy/tenant-db.js';
import { describeDb, testDatabase, type TestDatabase } from '../../helpers/database.js';
import { identityHarness } from '../../helpers/identity.js';
import { freePort } from '../../helpers/net.js';

const TOKEN = 'proxy-token-integration-0123456789abcdefghij';
const NOW = new Date('2026-11-04T10:00:00Z');

describeDb('the proxy listener (hosted spec §23.4)', () => {
  let db: TestDatabase;
  let tenancy: Tenancy;
  let tenants: TenantDb[];
  let dir: string;
  let listener: ProxyListener | undefined;
  const log = (): FastifyBaseLogger => Fastify({ logger: { level: 'silent' } }).log;
  const hosted = (tokenFile: string, listen: string | undefined): ServerConfig =>
    ({
      mode: 'hosted',
      appDomain: 'app.test',
      siteDomain: 'site.test',
      ...(listen !== undefined ? { proxyListen: listen } : {}),
      proxyTokenFile: tokenFile,
    }) as ServerConfig;

  beforeAll(async () => {
    db = await testDatabase();
    tenancy = createTenancy(db);
    const admin = new TenantAdmin(db, directoryOf(tenancy));
    tenants = [];
    for (const slug of ['cd-proxy-a', 'cd-proxy-b', 'cd-proxy-c', 'cd-proxy-d', 'cd-proxy-e']) {
      tenants.push(tenancy.db((await admin.create({ slug, name: slug })).scope));
    }
    dir = await mkdtemp(join(tmpdir(), 'wb-proxy-'));
    await writeFile(join(dir, 'token'), `${TOKEN}\n`, { mode: 0o600 });
  });
  afterEach(async () => {
    await listener?.close();
    listener = undefined;
    for (const t of tenants) await t.transaction((tx) => removeClaim(tx));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
    await db?.close();
  });

  /** A claim in `state`, holding its name exactly when that state does, as the check job leaves it. */
  const claimed = (t: TenantDb, name: string, state: DomainState) =>
    t.transaction(async (tx) => {
      const made = await claim(tx, { name, createdBy: null, now: NOW });
      if (state === 'verified' || state === 'active' || state === 'failing') expect(await hold(tx, name)).toBe('held');
      await record(tx, made.token, {
        state,
        lastResult: { cname: 'ok', txt: 'ok', message: '' },
        checkedAt: NOW,
        failingSince: state === 'failing' ? NOW : null,
      });
    });
  const poll = async (headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }) => {
    const response = await fetch(`http://127.0.0.1:${String(listener!.port)}${PROXY_ROUTE}`, { headers });
    return { status: response.status, body: (await response.json()) as unknown };
  };

  it('answers the verified, active and failing names of every tenant, and no other', async () => {
    const [a, b, c, d, e] = tenants as [TenantDb, TenantDb, TenantDb, TenantDb, TenantDb];
    await claimed(a, 'verified.customer.test', 'verified');
    await claimed(b, 'active.customer.test', 'active');
    await claimed(c, 'failing.customer.test', 'failing');
    await claimed(d, 'pending.customer.test', 'pending');
    await claimed(e, 'lapsed.customer.test', 'lapsed');
    listener = await startProxyListener(
      hosted(join(dir, 'token'), `127.0.0.1:${String(await freePort())}`),
      tenancy,
      log(),
      { cacheMs: 0 },
    );
    expect(listener).toBeDefined();
    expect(await poll()).toEqual({
      status: 200,
      body: traefikPayload(['active.customer.test', 'failing.customer.test', 'verified.customer.test']),
    });
    // A name released (lapsed, paused, expired or removed) is gone at the next poll.
    await b.transaction((tx) => release(tx, 'active.customer.test'));
    await c.transaction((tx) => removeClaim(tx));
    expect((await poll()).body).toEqual(traefikPayload(['verified.customer.test']));
    await a.transaction((tx) => removeClaim(tx));
    expect((await poll()).body).toEqual({ http: { routers: {} } });
  });

  it('answers 401 without the token', async () => {
    listener = await startProxyListener(
      hosted(join(dir, 'token'), `127.0.0.1:${String(await freePort())}`),
      tenancy,
      log(),
      { cacheMs: 0 },
    );
    expect((await poll({})).status).toBe(401);
    expect((await poll({ authorization: 'Bearer nope' })).status).toBe(401);
  });

  it('does not listen when the listener is unset, nor in self-hosted mode', async () => {
    expect(await startProxyListener(hosted(join(dir, 'token'), undefined), tenancy, log())).toBeUndefined();
    const selfHosted = {
      ...hosted(join(dir, 'token'), `127.0.0.1:${String(await freePort())}`),
      mode: 'self-hosted',
    } as ServerConfig;
    expect(await startProxyListener(selfHosted, tenancy, log())).toBeUndefined();
  });

  it('refuses to start without a readable token', async () => {
    await expect(
      startProxyListener(hosted(join(dir, 'missing'), `127.0.0.1:${String(await freePort())}`), tenancy, log()),
    ).rejects.toThrow(/WIREBENCH_SERVER_PROXY_TOKEN_FILE cannot be read/);
  });

  it('is not on the public listener', async () => {
    const h = await identityHarness({
      configure: (config) => ({ ...config, mode: 'hosted', appDomain: 'app.test', siteDomain: 'site.test' }),
    });
    try {
      for (const host of ['app.app.test', 'cd-proxy-a.app.test']) {
        const response = await h.app.inject({
          method: 'GET',
          url: PROXY_ROUTE,
          headers: { host, authorization: `Bearer ${TOKEN}` },
        });
        expect(response.statusCode, host).toBe(404);
        expect(response.body).not.toContain('routers');
      }
    } finally {
      await h.app.close();
      await h.db.close();
    }
  });
});
