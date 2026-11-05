/**
 * `wirebench-server admin domains …` (hosted edition spec §23.6): `list` across tenants with slug, name, state and
 * checked at and never a token; `check --tenant` checks now; `remove --tenant` releases the name, audited. Hosted
 * only, through `runAdmin`'s test seam since `loadConfig` refuses hosted mode (§19.1). DNS is a fake: no real DNS.
 */
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { cluster, serverHooks } from '../../../src/context.js';
import { openSession } from '../../../src/db/pool.js';
import { NotificationBus } from '../../../src/operations/bus.js';
import type { ServerConfig } from '../../../src/config.js';
import type { DnsLookup } from '../../../src/custom-domains/dns.js';
import { claim, getClaim } from '../../../src/custom-domains/repo.js';
import { runAdmin } from '../../../src/identity/cli.js';
import { TenantAdmin } from '../../../src/tenancy/directory.js';
import type { TenantScope } from '../../../src/tenancy/scope.js';
import { createTenancy, directoryOf, type Tenancy } from '../../../src/tenancy/tenancy.js';
import { describeDb, testDatabase } from '../../helpers/database.js';
import { mkTempDir, removeTempDir } from '../../helpers/git.js';
import { testKeys } from '../../helpers/licensing.js';

const APP = 'example.test';
const NAME = 'app.customer.test';
const hosted = (config: ServerConfig): ServerConfig => ({
  ...config,
  mode: 'hosted',
  appDomain: APP,
  siteDomain: 'site.test',
});
const notFound = () => Promise.reject(Object.assign(new Error('not found'), { code: 'ENOTFOUND' }));

describeDb('admin domains (spec §23.6)', () => {
  let db: Awaited<ReturnType<typeof testDatabase>>;
  let tenancy: Tenancy;
  let acme: TenantScope;
  let beta: TenantScope;
  let dir: string;
  let tokenAcme: string;
  let tokenBeta: string;
  const keys = testKeys();
  const txts = new Map<string, string[]>();
  const lookup: DnsLookup = {
    cname: (name) => (name === NAME ? Promise.resolve([`custom.${APP}`]) : notFound()),
    a: notFound,
    aaaa: notFound,
    txt: (name) => {
      const values = txts.get(name);
      return values === undefined ? notFound() : Promise.resolve(values.map((value) => [value]));
    },
  };
  const options = {
    configure: hosted,
    publicKeys: [keys.publicKey],
    domains: { lookup, probe: null, mail: null },
  };
  const io = () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    return {
      io: {
        stdout: { write: (text: string) => stdout.push(text) },
        stderr: { write: (text: string) => stderr.push(text) },
        env: {
          WIREBENCH_SERVER_DATABASE_URL: db.url,
          WIREBENCH_SERVER_PUBLIC_URL: 'https://wirebench.test',
          WIREBENCH_SERVER_LOG_LEVEL: 'fatal',
        },
      },
      stdout: () => stdout.join(''),
      stderr: () => stderr.join(''),
    };
  };
  const hosts = async () => (await db.query<{ host: string }>('select host from tenant_hosts')).rows;

  beforeAll(async () => {
    db = await testDatabase();
    dir = await mkTempDir();
    tenancy = createTenancy(db);
    await directoryOf(tenancy).load();
    const admin = new TenantAdmin(db, directoryOf(tenancy));
    acme = (await admin.create({ slug: 'acme', name: 'Acme' })).scope;
    beta = (await admin.create({ slug: 'beta', name: 'Beta' })).scope;
    await admin.create({ slug: 'gamma', name: 'Gamma' });
    const at = new Date('2026-11-04T10:00:00Z');
    tokenAcme = (await tenancy.db(acme).transaction((tx) => claim(tx, { name: NAME, createdBy: null, now: at }))).token;
    tokenBeta = (
      await tenancy.db(beta).transaction((tx) => claim(tx, { name: 'beta.customer.test', createdBy: null, now: at }))
    ).token;
    // Hosted: the tenant row is the edition (spec §22.4).
    await db.query("update tenants set edition = 'enterprise', edition_source = 'operator' where id = $1::uuid", [
      acme.tenantId,
    ]);
  });
  afterAll(async () => {
    await db.close();
    await removeTempDir(dir);
  });

  it('list prints every tenant’s claim: slug, name, state and checked at, never a token', async () => {
    const out = io();
    expect(await runAdmin({ command: 'admin-domains-list' }, out.io, options), out.stderr()).toBe(0);
    const lines = out.stdout().trimEnd().split('\n');
    expect(lines[0]).toMatch(/^SLUG\s+NAME\s+STATE\s+CHECKED$/);
    expect(lines.slice(1).map((line) => line.split(/\s+/))).toEqual([
      ['acme', NAME, 'pending', '-'],
      ['beta', 'beta.customer.test', 'pending', '-'],
    ]);
    expect(out.stdout()).not.toContain(tokenAcme);
    expect(out.stdout()).not.toContain(tokenBeta);
  });

  it('check --tenant checks the name now, and says so', async () => {
    txts.set(`_wirebench.${NAME}`, [`wirebench-domain-verification=${tokenAcme}`]);
    const out = io();
    expect(await runAdmin({ command: 'admin-domains-check', tenant: 'acme' }, out.io, options), out.stderr()).toBe(0);
    expect(out.stdout()).toMatch(new RegExp(`^${NAME.replaceAll('.', '\\.')}  verified  checked \\d{4}-`));
    expect(out.stdout()).not.toContain(tokenAcme);
    expect(await hosts()).toEqual([{ host: NAME }]);
    const listed = io();
    await runAdmin({ command: 'admin-domains-list' }, listed.io, options);
    expect(listed.stdout()).toMatch(/acme\s+app\.customer\.test\s+verified\s+\d{4}-/);
  });

  it('check and remove refuse a tenant with no claim (custom-domains-none)', async () => {
    for (const command of ['admin-domains-check', 'admin-domains-remove'] as const) {
      const out = io();
      expect(await runAdmin({ command, tenant: 'gamma' }, out.io, options)).toBe(1);
      expect(out.stderr()).toContain('custom-domains-none');
    }
  });

  it('remove --tenant releases the name and records custom_domain.removed in that tenant, by the system', async () => {
    // A running instance: it hears the release on the bus, and reloads its tenant map (spec §23.5, §20.3).
    const hooks = serverHooks();
    const heard: unknown[] = [];
    hooks.tenantsChanged.push(cluster((event) => heard.push(event)));
    const bus = new NotificationBus({
      db,
      holder: randomUUID(),
      hooks,
      open: () => openSession(db.url, { applicationName: 'wirebench-test-bus' }),
      scopeFor: () => Promise.resolve(undefined),
      log: Fastify({ logger: false }).log,
    });
    await bus.start();
    const out = io();
    try {
      expect(await runAdmin({ command: 'admin-domains-remove', tenant: 'acme' }, out.io, options), out.stderr()).toBe(
        0,
      );
      await vi.waitFor(() => expect(heard.length).toBeGreaterThan(0), { timeout: 5_000, interval: 20 });
    } finally {
      await bus.stop(0);
    }
    expect(out.stdout()).toBe(`Removed ${NAME}\n`);
    expect(await hosts()).toEqual([]);
    expect(await tenancy.db(acme).transaction((tx) => getClaim(tx))).toBeUndefined();
    expect(await tenancy.db(beta).transaction((tx) => getClaim(tx))).toBeDefined();
    const events = await tenancy
      .db(acme)
      .query<{ action: string; actor_kind: string; details: Record<string, unknown> }>(
        "select action, actor_kind, details from audit_events where action = 'custom_domain.removed'",
      );
    expect(events.rows).toEqual([
      { action: 'custom_domain.removed', actor_kind: 'system', details: { name: NAME, state: 'verified' } },
    ]);
  });

  it('check and remove need --tenant in hosted mode; list takes none', async () => {
    const out = io();
    expect(await runAdmin({ command: 'admin-domains-check' }, out.io, options)).toBe(2);
    expect(out.stderr()).toContain('--tenant <slug> is required in hosted mode');
  });

  it('self-hosted: every domains command is refused as hosted only', async () => {
    for (const command of [
      { command: 'admin-domains-list' },
      { command: 'admin-domains-check', tenant: 'acme' },
      { command: 'admin-domains-remove' },
    ] as const) {
      const out = io();
      expect(await runAdmin(command, out.io), command.command).toBe(1);
      expect(out.stderr(), command.command).toContain('custom-domains-hosted-only');
    }
  });
});
