/**
 * `/api/v1/tenant/domain` (hosted edition spec §23.6) on two hosted tenants, acme (A) and beta (B), with a fake
 * `DnsLookup`, no certificate probe and no mail: the four routes, the server-admin and feature gates, Check now's
 * once a minute, `held-elsewhere` without the holder, isolation through the routes, and the job's timer. Self-hosted,
 * every route answers `404 custom-domains-hosted-only` and no job is armed. No real DNS: every name is under `.test`.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { auditLogModule } from '../../../src/audit-log/module.js';
import type { DnsLookup } from '../../../src/custom-domains/dns.js';
import { PROBE_EVERY_MS } from '../../../src/custom-domains/job.js';
import { CHECK_EVERY_MS, CHECK_NOW_EVERY_MS, customDomainsModule } from '../../../src/custom-domains/module.js';
import { licensingModule } from '../../../src/licensing/module.js';
import { describeDb } from '../../helpers/database.js';
import { identityHarness, signedInUser, type IdentityHarness, type SignedInUser } from '../../helpers/identity.js';
import { license, testKeys } from '../../helpers/licensing.js';
import { manualTimers } from '../../helpers/timers.js';
import { APP_DOMAIN, twoTenants, type Tenant, type TwoTenants } from '../tenancy/modules/two-tenants.js';

const KEY = 'test-chain-key-0123456789abcdefghij';
const NAME = 'app.customer.test';
const keys = testKeys();

/** DNS as a test sets it: a CNAME per name, TXT strings per `_wirebench.` name; everything else is ENOTFOUND. */
class FakeDns implements DnsLookup {
  readonly cnames = new Map<string, string>();
  readonly txts = new Map<string, string[]>();
  asked = 0;
  private answer<T>(value: T | undefined): Promise<T> {
    this.asked++;
    if (value === undefined) return Promise.reject(Object.assign(new Error('not found'), { code: 'ENOTFOUND' }));
    return Promise.resolve(value);
  }
  cname(name: string) {
    const target = this.cnames.get(name);
    return this.answer(target === undefined ? undefined : [target]);
  }
  a() {
    return this.answer<string[]>(undefined);
  }
  aaaa() {
    return this.answer<string[]>(undefined);
  }
  txt(name: string) {
    return this.answer(this.txts.get(name)?.map((value) => [value]));
  }
  prove(name: string, ...values: string[]) {
    this.cnames.set(name, `custom.${APP_DOMAIN}`);
    this.txts.set(`_wirebench.${name}`, values);
  }
}

interface Wire {
  readonly name?: string;
  readonly state?: string;
  readonly records?: readonly { type: string; name: string; value: string }[];
  readonly lastResult?: { cname: string; txt: string; heldElsewhere?: true; message: string } | null;
  readonly checkedAt?: string | null;
  readonly code?: string;
}

const txtOf = (body: Wire) => body.records!.find((record) => record.type === 'TXT')!.value;

it('the job ticks no slower than the certificate probe, and Check now is once a minute (spec §23.2, §23.4)', () => {
  expect(CHECK_EVERY_MS).toBeLessThanOrEqual(PROBE_EVERY_MS);
  expect(CHECK_NOW_EVERY_MS).toBe(60_000);
});

describeDb('the custom-domain routes, hosted (spec §23.6)', () => {
  let t: TwoTenants;
  const dns = new FakeDns();
  const timers = manualTimers();
  const admins: Partial<Record<'acme' | 'beta', SignedInUser>> = {};
  const members: Partial<Record<'acme' | 'beta', SignedInUser>> = {};
  const admin = (tenant: Tenant) => admins[tenant.slug]!;
  const install = async (tenant: Tenant, edition: 'team' | 'enterprise') => {
    const res = await tenant.call(admin(tenant), 'PUT', '/license', { license: license(keys, { edition }) });
    expect(res.status).toBe(200);
  };
  const call = (tenant: Tenant, method: 'GET' | 'PUT' | 'POST' | 'DELETE', payload?: object) =>
    tenant.call<Wire>(admin(tenant), method, method === 'POST' ? '/tenant/domain/check' : '/tenant/domain', payload);
  const events = async (tenant: Tenant) =>
    (
      await tenant.tdb.query<{ action: string; details: Record<string, unknown> }>(
        "select action, details from audit_events where action like 'custom_domain.%' order by id",
      )
    ).rows;
  const hosts = async () =>
    (await t.h.db.query<{ host: string; tenant_id: string }>('select host, tenant_id from tenant_hosts')).rows;

  beforeAll(async () => {
    t = await twoTenants({
      env: { WIREBENCH_SERVER_AUDIT_CHAIN_KEY: KEY },
      modules: (clock) => [
        licensingModule({ now: () => clock.now, publicKeys: [keys.publicKey] }),
        auditLogModule({ now: () => clock.now, setTimer: timers.setTimer }),
        customDomainsModule({
          now: () => clock.now,
          lookup: dns,
          probe: null,
          mail: null,
          setTimer: timers.setTimer,
          allowTestNames: true,
        }),
      ],
    });
    for (const tenant of [t.a, t.b]) {
      admins[tenant.slug] = await tenant.user({ email: `root@${tenant.slug}.test`, serverAdmin: true });
      members[tenant.slug] = await tenant.user({ email: `member@${tenant.slug}.test` });
    }
    await install(t.a, 'enterprise');
    await install(t.b, 'team');
  });
  afterAll(() => t?.close());

  it('answers 401 without a caller, 403 to a member, and 403 licensing-feature-required without the feature', async () => {
    expect((await t.a.call(undefined, 'GET', '/tenant/domain')).status).toBe(401);
    expect((await t.a.call(members.acme, 'GET', '/tenant/domain')).status).toBe(403);
    expect((await t.a.call(members.acme, 'PUT', '/tenant/domain', { name: NAME })).status).toBe(403);
    for (const method of ['GET', 'PUT', 'POST', 'DELETE'] as const) {
      const res = await call(t.b, method, method === 'PUT' ? { name: NAME } : undefined);
      expect(res.status, method).toBe(403);
      expect(res.body.code, method).toBe('licensing-feature-required');
    }
    await install(t.b, 'enterprise');
  });

  it('GET answers {} before a claim', async () => {
    expect(await call(t.a, 'GET')).toEqual({ status: 200, body: {} });
  });

  it('PUT refuses a name with the reason from checkCustomName', async () => {
    for (const [name, code] of [
      ['https://app.customer.test', 'custom-name-invalid'],
      ['*.customer.test', 'custom-name-invalid'],
      [`team.${APP_DOMAIN}`, 'custom-name-ours'],
      ['www.site.test', 'custom-name-ours'],
      ['app.customer.local', 'custom-name-local'],
    ] as const) {
      const res = await call(t.a, 'PUT', { name });
      expect(res.status, name).toBe(400);
      expect(res.body.code, name).toBe(code);
    }
    expect((await call(t.a, 'PUT', {})).status).toBe(400);
  });

  it('PUT claims the name: pending, with the CNAME to custom.<app-domain> and the TXT token, audited by name only', async () => {
    const res = await call(t.a, 'PUT', { name: 'App.Customer.TEST' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: NAME, state: 'pending', lastResult: null, checkedAt: null });
    expect(res.body.records!.map(({ type, name }) => ({ type, name }))).toEqual([
      { type: 'CNAME', name: NAME },
      { type: 'TXT', name: `_wirebench.${NAME}` },
    ]);
    expect(res.body.records![0]!.value).toBe(`custom.${APP_DOMAIN}`);
    expect(txtOf(res.body)).toMatch(/^wirebench-domain-verification=[\w-]{43}$/);
    expect((await call(t.a, 'GET')).body).toEqual(res.body);
    const claimed = (await events(t.a)).filter((event) => event.action === 'custom_domain.claimed');
    expect(claimed).toEqual([{ action: 'custom_domain.claimed', details: { name: NAME } }]);
    expect(JSON.stringify(await events(t.a))).not.toContain(txtOf(res.body).split('=')[1]);
  });

  it('a second PUT answers 409 custom-domains-one-per-tenant', async () => {
    const res = await call(t.a, 'PUT', { name: 'other.customer.test' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('custom-domains-one-per-tenant');
    expect((await call(t.a, 'GET')).body.name).toBe(NAME);
  });

  it('POST …/check checks now and answers like GET, at most once a minute (429 with retry-after)', async () => {
    const token = txtOf((await call(t.a, 'GET')).body);
    dns.prove(NAME, token);
    const checked = await call(t.a, 'POST');
    expect(checked.status).toBe(200);
    expect(checked.body).toMatchObject({ name: NAME, state: 'verified', lastResult: { cname: 'ok', txt: 'ok' } });
    expect(checked.body.checkedAt).toBe(t.h.clock.now.toISOString());
    expect((await call(t.a, 'GET')).body).toEqual(checked.body);
    expect(await hosts()).toEqual([{ host: NAME, tenant_id: t.a.scope.tenantId }]);

    const again = await t.a.inject({ method: 'POST', url: '/api/v1/tenant/domain/check', headers: admin(t.a).headers });
    expect(again.statusCode).toBe(429);
    expect(again.json()).toMatchObject({ code: 'custom-domains-check-rate-limited' });
    expect(Number(again.headers['retry-after'])).toBeGreaterThan(0);
    t.h.clock.advance(CHECK_NOW_EVERY_MS);
    expect((await call(t.a, 'POST')).status).toBe(200);
  });

  it("B's claim of A's name stays pending and reads held-elsewhere, never naming acme", async () => {
    const claimed = await call(t.b, 'PUT', { name: NAME });
    expect(claimed.status).toBe(200);
    expect(claimed.body.state).toBe('pending');
    const tokenA = txtOf((await call(t.a, 'GET')).body);
    const tokenB = txtOf(claimed.body);
    expect(tokenB).not.toBe(tokenA);
    dns.prove(NAME, tokenA, tokenB);
    const checked = await call(t.b, 'POST');
    expect(checked.status).toBe(200);
    expect(checked.body).toMatchObject({ state: 'pending', lastResult: { heldElsewhere: true } });
    const text = JSON.stringify(checked.body);
    for (const leak of ['acme', t.a.scope.tenantId, tokenA.split('=')[1]!]) expect(text).not.toContain(leak);
    expect(await hosts()).toEqual([{ host: NAME, tenant_id: t.a.scope.tenantId }]);
  });

  it("B cannot read, check or remove A's claim through the routes", async () => {
    const before = (await call(t.a, 'GET')).body;
    const read = await call(t.b, 'GET');
    expect(read.body.name).toBe(NAME);
    expect(read.body.state).toBe('pending');
    expect(txtOf(read.body)).not.toBe(txtOf(before));
    t.h.clock.advance(CHECK_NOW_EVERY_MS);
    expect((await call(t.b, 'POST')).body.state).toBe('pending');
    expect((await call(t.b, 'DELETE')).status).toBe(204);
    expect(await call(t.b, 'GET')).toEqual({ status: 200, body: {} });
    // B's check and removal touched B's claim only: A's, and the name it holds, are as they were.
    expect((await call(t.a, 'GET')).body).toEqual(before);
    expect(await hosts()).toEqual([{ host: NAME, tenant_id: t.a.scope.tenantId }]);
    expect((await events(t.b)).map((event) => event.action)).toEqual([
      'custom_domain.claimed',
      'custom_domain.removed',
    ]);
  });

  it('DELETE releases the name, answers 204 (again when nothing is left), and is audited', async () => {
    expect((await call(t.a, 'DELETE')).status).toBe(204);
    expect(await call(t.a, 'GET')).toEqual({ status: 200, body: {} });
    expect(await hosts()).toEqual([]);
    expect((await call(t.a, 'DELETE')).status).toBe(204);
    const removed = (await events(t.a)).filter((event) => event.action === 'custom_domain.removed');
    expect(removed).toEqual([{ action: 'custom_domain.removed', details: { name: NAME, state: 'verified' } }]);
    t.h.clock.advance(CHECK_NOW_EVERY_MS);
    expect(await call(t.a, 'POST')).toEqual({ status: 200, body: {} });
  });

  it('the job runs a pass every CHECK_EVERY_MS on its timer, and re-arms when the pass ends', async () => {
    expect((await call(t.a, 'PUT', { name: 'next.customer.test' })).status).toBe(200);
    expect(timers.pending(CHECK_EVERY_MS)).toBe(1);
    dns.asked = 0;
    expect(timers.fire(CHECK_EVERY_MS)).toBe(1);
    await vi.waitFor(() => expect(timers.pending(CHECK_EVERY_MS)).toBe(1));
    expect(dns.asked).toBeGreaterThan(0);
    expect((await call(t.a, 'GET')).body.checkedAt).toBe(t.h.clock.now.toISOString());
  });
});

describeDb('the custom-domain routes, self-hosted (spec §23.1)', () => {
  let h: IdentityHarness;
  let root: SignedInUser;
  const timers = manualTimers();
  beforeAll(async () => {
    h = await identityHarness({
      modules: (clock) => [
        licensingModule({ now: () => clock.now, publicKeys: [keys.publicKey] }),
        customDomainsModule({ now: () => clock.now, lookup: new FakeDns(), setTimer: timers.setTimer }),
      ],
    });
    root = await signedInUser(h, { email: 'root@example.test', serverAdmin: true });
    const res = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/license',
      headers: root.headers,
      payload: { license: license(keys, { edition: 'enterprise' }) },
    });
    expect(res.statusCode).toBe(200);
  });
  afterAll(() => h?.close());

  it('every route answers 404 custom-domains-hosted-only, even to an Enterprise server admin, and no job is armed', async () => {
    for (const [method, url] of [
      ['GET', '/api/v1/tenant/domain'],
      ['PUT', '/api/v1/tenant/domain'],
      ['POST', '/api/v1/tenant/domain/check'],
      ['DELETE', '/api/v1/tenant/domain'],
    ] as const) {
      for (const headers of [root.headers, {}]) {
        const res = await h.app.inject({
          method,
          url,
          headers,
          ...(method === 'PUT' ? { payload: { name: NAME } } : {}),
        });
        expect(res.statusCode, `${method} ${url}`).toBe(404);
        expect(res.json(), `${method} ${url}`).toMatchObject({ code: 'custom-domains-hosted-only' });
      }
    }
    expect(timers.pending(CHECK_EVERY_MS)).toBe(0);
  });
});
