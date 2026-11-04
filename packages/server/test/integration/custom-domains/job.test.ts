/**
 * The custom-name check job (hosted edition spec §23.2), on the test database with a fake `DnsLookup`, a fake clock
 * and a stubbed certificate probe: its schedule, every move it makes on `tenant_hosts`, its audit events and its mail.
 * No real DNS and no real domain: every name is under `.test`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { auditHook } from '../../../src/audit-log/hook.js';
import { serverHooks } from '../../../src/context.js';
import type { DnsLookup } from '../../../src/custom-domains/dns.js';
import {
  checkPass,
  checkTenant,
  HELD_EVERY_MS,
  PENDING_EVERY_MS,
  type CheckDeps,
  type ProbeResult,
} from '../../../src/custom-domains/job.js';
import type { DomainEmail } from '../../../src/custom-domains/mail.js';
import { claim, getClaim, removeClaim } from '../../../src/custom-domains/repo.js';
import { FAILING_FOR_MS, PENDING_FOR_MS } from '../../../src/custom-domains/states.js';
import { TenantAdmin } from '../../../src/tenancy/directory.js';
import type { TenantScope } from '../../../src/tenancy/scope.js';
import { createTenancy, directoryOf, type Tenancy } from '../../../src/tenancy/tenancy.js';
import { outsideTenantUnit, type TenantDb, type TenantQuerier } from '../../../src/tenancy/tenant-db.js';
import { describeDb, testDatabase, type TestDatabase } from '../../helpers/database.js';

const APP = 'app.test';
const NAME = 'app.customer.test';
const START = new Date('2026-11-04T10:00:00Z');
const HOUR = 3_600_000;

/** DNS as a test sets it: a CNAME per name, TXT strings per `_wirebench.` name. Everything else is ENOTFOUND. */
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
    const values = this.txts.get(name);
    return this.answer(values?.map((value) => [value]));
  }
  /** Puts both of `name`'s records in place for `tokens`. */
  prove(name: string, ...tokens: string[]) {
    this.cnames.set(name, `custom.${APP}`);
    this.txts.set(
      `_wirebench.${name}`,
      tokens.map((token) => `wirebench-domain-verification=${token}`),
    );
  }
  clear(name: string) {
    this.cnames.delete(name);
    this.txts.delete(`_wirebench.${name}`);
  }
}

describeDb('the custom-name check job (hosted spec §23.2)', () => {
  let db: TestDatabase;
  let tenancy: Tenancy;
  let scopeA: TenantScope;
  let scopeB: TenantScope;
  let a: TenantDb;
  let b: TenantDb;
  let clock: Date;
  let dns: FakeDns;
  let features: Map<string, readonly string[]>;
  let featureFailure: Set<string>;
  let probe: ((name: string) => Promise<ProbeResult>) | undefined;
  let sent: { to: readonly string[]; email: DomainEmail }[];
  let mailOn: boolean;
  const warnings: unknown[] = [];
  let hooks = serverHooks();

  const advance = (ms: number) => {
    clock = new Date(clock.getTime() + ms);
  };
  const deps = (): CheckDeps => ({
    tenancy,
    lookup: dns,
    appDomain: APP,
    now: () => clock,
    hooks,
    features: (scope) =>
      featureFailure.has(scope.tenantId)
        ? Promise.reject(new Error('license unreadable'))
        : Promise.resolve(features.get(scope.tenantId) ?? []),
    ...(probe !== undefined ? { probe } : {}),
    ...(mailOn
      ? {
          mail: (to: readonly string[], email: DomainEmail) => {
            sent.push({ to, email });
            return Promise.resolve();
          },
        }
      : {}),
    log: { error: () => undefined, warn: (...args: unknown[]) => void warnings.push(args) },
  });
  const pass = () => checkPass(deps());
  const claimOf = (t: TenantDb) => t.transaction((tx) => getClaim(tx));
  const hosts = async () =>
    (
      await db.query<{ host: string; tenant_id: string; live: boolean }>(
        'select host, tenant_id, live from tenant_hosts order by host',
      )
    ).rows;
  const events = async (t: TenantDb) =>
    (
      await t.query<{ action: string; actor_kind: string; target_kind: string; details: Record<string, unknown> }>(
        "select action, actor_kind, target_kind, details from audit_events where action like 'custom_domain.%' order by at, id",
      )
    ).rows;

  beforeAll(async () => {
    db = await testDatabase();
    tenancy = createTenancy(db);
    const admin = new TenantAdmin(db, directoryOf(tenancy));
    scopeA = (await admin.create({ slug: 'cd-job-a', name: 'A' })).scope;
    scopeB = (await admin.create({ slug: 'cd-job-b', name: 'B' })).scope;
    a = tenancy.db(scopeA);
    b = tenancy.db(scopeB);
    for (const [t, slug] of [
      [a, 'a'],
      [b, 'b'],
    ] as const) {
      await t.query(
        `insert into users (id, email, email_lower, display_name, server_admin, created_at) values
          ($1, $2, $2, 'Admin', true, now()), ($3, $4, $4, 'Member', false, now())`,
        [
          `cd-job-admin-${slug}`,
          `admin@${slug}.customer.test`,
          `cd-job-member-${slug}`,
          `member@${slug}.customer.test`,
        ],
      );
    }
  });
  beforeEach(() => {
    clock = START;
    dns = new FakeDns();
    features = new Map([
      [scopeA.tenantId, ['custom-domains']],
      [scopeB.tenantId, ['custom-domains']],
    ]);
    featureFailure = new Set();
    probe = undefined;
    sent = [];
    mailOn = true;
    warnings.length = 0;
    hooks = serverHooks();
    hooks.audit.push(auditHook(() => clock));
  });
  afterEach(async () => {
    for (const t of [a, b]) {
      await t.transaction((tx) => removeClaim(tx));
      await t.query("delete from audit_events where action like 'custom_domain.%'");
    }
    await db.query('delete from tenant_hosts');
  });
  afterAll(async () => {
    await db?.close();
  });

  const claimA = async (name = NAME) => a.transaction((tx) => claim(tx, { name, createdBy: null, now: clock }));
  const claimB = async (name = NAME) => b.transaction((tx) => claim(tx, { name, createdBy: null, now: clock }));

  it('checks a pending claim hourly, and moves it to verified on a pass, holding the name', async () => {
    const made = await claimA();
    await pass();
    expect(dns.asked).toBeGreaterThan(0);
    expect(await claimOf(a)).toMatchObject({ state: 'pending', checkedAt: START, lastResult: { cname: 'missing' } });
    // Not due again within the hour.
    dns.prove(NAME, made.token);
    const asked = dns.asked;
    advance(PENDING_EVERY_MS - 1);
    await pass();
    expect(dns.asked).toBe(asked);
    expect((await claimOf(a))?.state).toBe('pending');
    advance(1);
    await pass();
    expect(await claimOf(a)).toMatchObject({
      state: 'verified',
      verifiedAt: clock,
      lastResult: { cname: 'ok', txt: 'ok' },
    });
    expect(await hosts()).toEqual([{ host: NAME, tenant_id: scopeA.tenantId, live: false }]);
    expect(PENDING_EVERY_MS).toBe(HOUR);
  });

  it('checks a held name every 6 hours', async () => {
    const made = await claimA();
    dns.prove(NAME, made.token);
    await pass();
    expect((await claimOf(a))?.state).toBe('verified');
    dns.clear(NAME);
    const asked = dns.asked;
    advance(HELD_EVERY_MS - 1);
    await pass();
    expect(dns.asked).toBe(asked);
    expect((await claimOf(a))?.state).toBe('verified');
    advance(1);
    await pass();
    expect((await claimOf(a))?.state).toBe('failing');
    expect(HELD_EVERY_MS).toBe(6 * HOUR);
  });

  it('activates a verified name when the certificate probe passes, marking it live, and mails the admins', async () => {
    const made = await claimA();
    dns.prove(NAME, made.token);
    const probed: string[] = [];
    probe = (name) => {
      probed.push(name);
      return Promise.resolve({ verdict: 'ok', message: 'The certificate covers the name.' });
    };
    await pass();
    expect(probed).toEqual([NAME]);
    expect(await claimOf(a)).toMatchObject({
      state: 'active',
      activeAt: START,
      lastResult: { cname: 'ok', txt: 'ok', certificate: 'ok' },
    });
    expect(await hosts()).toEqual([{ host: NAME, tenant_id: scopeA.tenantId, live: true }]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toEqual(['admin@a.customer.test']);
    expect(sent[0]!.email.subject).toContain(NAME);
    expect(sent[0]!.email.text).toMatch(/redirect URI or ACS URL/);
    expect((await events(a)).map((event) => event.action)).toEqual([
      'custom_domain.verified',
      'custom_domain.activated',
    ]);
  });

  it('keeps a verified name waiting while the probe fails, and without a probe', async () => {
    const made = await claimA();
    dns.prove(NAME, made.token);
    await pass();
    expect((await claimOf(a))?.state).toBe('verified');
    probe = () => Promise.resolve({ verdict: 'missing', message: 'No certificate yet.' });
    advance(HELD_EVERY_MS);
    await pass();
    expect(await claimOf(a)).toMatchObject({ state: 'verified', lastResult: { certificate: 'missing' } });
    probe = () => Promise.reject(new Error('connection refused'));
    advance(HELD_EVERY_MS);
    await pass();
    expect((await claimOf(a))?.state).toBe('verified');
    expect(await hosts()).toEqual([{ host: NAME, tenant_id: scopeA.tenantId, live: false }]);
  });

  it('fails a held name for 72 hours, mailing once, then lapses it and releases the name', async () => {
    const made = await claimA();
    dns.prove(NAME, made.token);
    probe = () => Promise.resolve({ verdict: 'ok', message: 'The certificate covers the name.' });
    await pass();
    expect((await claimOf(a))?.state).toBe('active');
    dns.clear(NAME);
    advance(HELD_EVERY_MS);
    const failedAt = clock;
    await pass();
    expect(await claimOf(a)).toMatchObject({ state: 'failing', failingSince: failedAt });
    // Still held and live while failing: still served.
    expect(await hosts()).toEqual([{ host: NAME, tenant_id: scopeA.tenantId, live: true }]);
    // Every 6 hours, until 72 hours have passed since failing_since.
    while (clock.getTime() + HELD_EVERY_MS < failedAt.getTime() + FAILING_FOR_MS) {
      advance(HELD_EVERY_MS);
      await pass();
      expect(await claimOf(a), clock.toISOString()).toMatchObject({ state: 'failing', failingSince: failedAt });
    }
    advance(failedAt.getTime() + FAILING_FOR_MS - clock.getTime());
    await pass();
    expect(await claimOf(a)).toMatchObject({ state: 'lapsed', failingSince: null });
    expect(await hosts()).toEqual([]);
    expect(sent.map((mail) => mail.email.subject)).toEqual([
      `${NAME} now serves your team`,
      `The DNS records of ${NAME} no longer check out`,
      `${NAME} has been released`,
    ]);
    expect((await events(a)).map((event) => event.action)).toEqual([
      'custom_domain.verified',
      'custom_domain.activated',
      'custom_domain.failing',
      'custom_domain.lapsed',
    ]);
  });

  it('sends a pass from lapsed back through verified, holding the name again', async () => {
    const made = await claimA();
    dns.prove(NAME, made.token);
    await pass();
    dns.clear(NAME);
    advance(HELD_EVERY_MS);
    await pass();
    advance(FAILING_FOR_MS);
    await pass();
    expect((await claimOf(a))?.state).toBe('lapsed');
    expect(await hosts()).toEqual([]);
    dns.prove(NAME, made.token);
    advance(HELD_EVERY_MS);
    await pass();
    expect((await claimOf(a))?.state).toBe('verified');
    expect(await hosts()).toEqual([{ host: NAME, tenant_id: scopeA.tenantId, live: false }]);
  });

  it('expires a claim pending for 7 days, and checks it no more', async () => {
    await claimA();
    await pass();
    // Due every hour; a day at a time is enough to see it stay pending.
    while (clock.getTime() + 24 * HOUR < START.getTime() + PENDING_FOR_MS) {
      advance(24 * HOUR);
      await pass();
    }
    expect((await claimOf(a))?.state).toBe('pending');
    advance(START.getTime() + PENDING_FOR_MS - clock.getTime());
    await pass();
    expect((await claimOf(a))?.state).toBe('expired');
    const asked = dns.asked;
    advance(HELD_EVERY_MS);
    await pass();
    expect(dns.asked).toBe(asked);
    expect((await events(a)).map((event) => event.action)).toEqual(['custom_domain.expired']);
  });

  it('pauses a claim and releases its name as soon as the feature is gone, due or not; a pass then re-verifies', async () => {
    const made = await claimA();
    dns.prove(NAME, made.token);
    probe = () => Promise.resolve({ verdict: 'ok', message: 'ok' });
    await pass();
    expect((await claimOf(a))?.state).toBe('active');
    features.set(scopeA.tenantId, []);
    advance(60_000);
    await pass();
    expect(await claimOf(a)).toMatchObject({ state: 'paused' });
    expect(await hosts()).toEqual([]);
    // The feature back: the next due check goes through verified again.
    features.set(scopeA.tenantId, ['custom-domains']);
    probe = undefined;
    advance(HELD_EVERY_MS);
    await pass();
    expect((await claimOf(a))?.state).toBe('verified');
    expect((await events(a)).map((event) => event.action)).toEqual([
      'custom_domain.verified',
      'custom_domain.activated',
      'custom_domain.paused',
      'custom_domain.verified',
    ]);
  });

  it('keeps a claim pending when another tenant holds the name, and says so without naming it', async () => {
    const first = await claimA();
    const second = await claimB();
    dns.prove(NAME, first.token, second.token);
    await pass();
    const states = [(await claimOf(a))!, (await claimOf(b))!];
    // The directory lists tenants in its own order: exactly one of the two holds it.
    const holder = states.findIndex((c) => c.state === 'verified');
    const other = states[1 - holder]!;
    expect(holder).not.toBe(-1);
    expect(other).toMatchObject({ state: 'pending', lastResult: { cname: 'ok', txt: 'ok', heldElsewhere: true } });
    expect(other.lastResult?.message).not.toMatch(/cd-job-|\bA\b|\bB\b/);
    expect(await hosts()).toEqual([{ host: NAME, tenant_id: [scopeA, scopeB][holder]!.tenantId, live: false }]);
  });

  it("records audit events in the tenant's own chain, as the system, with no token anywhere", async () => {
    const made = await claimA();
    dns.prove(NAME, made.token);
    await pass();
    const own = await events(a);
    expect(own).toEqual([
      {
        action: 'custom_domain.verified',
        actor_kind: 'system',
        target_kind: 'custom-domain',
        details: { name: NAME, from: 'pending', to: 'verified' },
      },
    ]);
    expect(await events(b)).toEqual([]);
    const everything = await a.query('select * from audit_events');
    expect(JSON.stringify(everything.rows)).not.toContain(made.token);
    expect(JSON.stringify(await claimOf(a))).toContain(made.token);
    expect(JSON.stringify((await claimOf(a))?.lastResult)).not.toContain(made.token);
  });

  it('mails nothing without SMTP, and only the server admins with it', async () => {
    mailOn = false;
    const made = await claimA();
    dns.prove(NAME, made.token);
    probe = () => Promise.resolve({ verdict: 'ok', message: 'ok' });
    await pass();
    expect((await claimOf(a))?.state).toBe('active');
    expect(sent).toEqual([]);
    mailOn = true;
    dns.clear(NAME);
    advance(HELD_EVERY_MS);
    await pass();
    expect(sent.map((mail) => mail.to)).toEqual([['admin@a.customer.test']]);
    expect(JSON.stringify(sent)).not.toContain(made.token);
  });

  it("goes on to the next tenant when one tenant's check fails", async () => {
    const first = await claimA();
    const second = await claimB('site.customer.test');
    dns.prove(NAME, first.token);
    dns.prove('site.customer.test', second.token);
    featureFailure.add(scopeA.tenantId);
    const result = await pass();
    expect(result.failed).toContain(scopeA.tenantId);
    expect((await claimOf(a))?.state).toBe('pending');
    expect((await claimOf(b))?.state).toBe('verified');
  });

  it('keeps nothing in tenant_hosts when the claim is removed between the check’s read and its hold', async () => {
    const made = await claimA();
    dns.prove(NAME, made.token);
    let removal: Promise<unknown> | undefined;
    // The check's unit, as the job gets it, except that its insert into tenant_hosts first starts the admin's
    // removal on another connection and gives it time to reach the row: the read has happened, the hold has not.
    const racing: Pick<Tenancy, 'db' | 'forEachTenant'> = {
      forEachTenant: (job, fn, log) => tenancy.forEachTenant(job, fn, log),
      db: (scope) => {
        const real = tenancy.db(scope);
        return new Proxy(real, {
          get(target, key, receiver) {
            if (key !== 'transaction') return Reflect.get(target, key, receiver) as unknown;
            return <T>(fn: (tx: TenantQuerier) => Promise<T>) =>
              target.transaction((tx) =>
                fn(
                  new Proxy(tx, {
                    get(inner, name, innerReceiver) {
                      if (name !== 'query') return Reflect.get(inner, name, innerReceiver) as unknown;
                      return async (text: string, values?: unknown[]) => {
                        if (removal === undefined && /^insert into tenant_hosts/.test(text)) {
                          removal = outsideTenantUnit(() => a.transaction((other) => removeClaim(other)));
                          await new Promise((resolve) => setTimeout(resolve, 300));
                        }
                        return inner.query(text, values);
                      };
                    },
                  }),
                ),
              );
          },
        });
      },
    };
    await checkPass({ ...deps(), tenancy: racing });
    expect(removal).toBeDefined();
    // The removal waited on the check's row lock, then released the name the check had just held.
    expect(await removal).toMatchObject({ name: NAME, token: made.token });
    expect(await claimOf(a)).toBeUndefined();
    expect(await hosts()).toEqual([]);
  });

  it('checks one tenant on demand, due or not', async () => {
    const made = await claimA();
    await pass();
    dns.prove(NAME, made.token);
    advance(60_000);
    expect((await checkTenant(deps(), scopeA))?.state).toBe('verified');
    expect(await checkTenant(deps(), scopeB)).toBeUndefined();
  });

  it('leaves a claim removed and made again during the check alone', async () => {
    const made = await claimA();
    dns.prove(NAME, made.token);
    let swapped = false;
    const lookup: DnsLookup = {
      ...dns,
      cname: async (name) => {
        if (!swapped) {
          swapped = true;
          await a.transaction(async (tx) => {
            await removeClaim(tx);
            await claim(tx, { name: NAME, createdBy: null, now: clock });
          });
        }
        return dns.cname(name);
      },
      a: () => dns.a(),
      aaaa: () => dns.aaaa(),
      txt: (name) => dns.txt(name),
    };
    await checkPass({ ...deps(), lookup });
    const after = await claimOf(a);
    expect(after?.token).not.toBe(made.token);
    expect(after).toMatchObject({ state: 'pending', checkedAt: null });
    expect(await hosts()).toEqual([]);
  });
});
