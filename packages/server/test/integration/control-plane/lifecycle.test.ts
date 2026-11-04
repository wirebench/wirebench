/**
 * The tenants' lifecycle (hosted edition spec §22.2, §22.3, §22.4, §22.7, §22.11; slice 7 Task 6): each verb is a
 * control transaction, writes `tenant.<verb>` in the tenant's own chain on the app role, and tells the directory,
 * whose change the bus carries to every other instance. Slugs are unique across `tenants`, open `signups` and
 * `tenant_slugs_retired` under the slug lock.
 */
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { auditHook } from '../../../src/audit-log/hook.js';
import type { ServerConfig } from '../../../src/config.js';
import { serverHooks, type ServerHooks } from '../../../src/context.js';
import { openControlDb, type ControlDb } from '../../../src/control-plane/control-db.js';
import { SLUG_LOCK, slugState } from '../../../src/control-plane/slugs.js';
import { DELETION_DAYS, TenantLifecycle } from '../../../src/control-plane/tenants.js';
import { openSession } from '../../../src/db/pool.js';
import { BusSignals, NotificationBus } from '../../../src/operations/bus.js';
import { InstanceRegistry } from '../../../src/operations/instances.js';
import { environmentKeyRoot } from '../../../src/tenancy/keys.js';
import type { TenantResolver } from '../../../src/tenancy/resolve.js';
import { ensureControlRole } from '../../../src/tenancy/roles.js';
import type { TenantScope } from '../../../src/tenancy/scope.js';
import { createTenancy, directoryOf, type Tenancy } from '../../../src/tenancy/tenancy.js';
import { describeDb, testDatabase, type TestDatabase } from '../../helpers/database.js';
import { mkTempDir, removeTempDir } from '../../helpers/git.js';
import { identityHarness, type IdentityHarness } from '../../helpers/identity.js';
import { manualTimers } from '../../helpers/timers.js';

const ROOT = Buffer.alloc(32, 7);
const NOW = new Date('2026-11-04T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

interface Rig {
  readonly db: TestDatabase;
  readonly control: ControlDb;
  readonly tenancy: Tenancy;
  readonly hooks: ServerHooks;
  readonly lifecycle: TenantLifecycle;
  /** How many times the directory told its listeners. */
  readonly changes: () => number;
}

async function rig(): Promise<Rig> {
  const db = await testDatabase();
  await ensureControlRole(db.owner, db.controlUrl, db.url);
  const control = openControlDb(db.controlUrl);
  const tenancy = createTenancy(db, { keyRoot: environmentKeyRoot(ROOT) });
  const hooks = serverHooks();
  // Its own clock, a second apart per row, so the rows read back in the order they were written.
  let tick = 0;
  hooks.audit.push(auditHook(() => new Date(NOW.getTime() + 1_000 * tick++)));
  let changes = 0;
  directoryOf(tenancy).onChange(() => {
    changes += 1;
  });
  return {
    db,
    control,
    tenancy,
    hooks,
    lifecycle: new TenantLifecycle({ control, tenancy, hooks, now: () => NOW }),
    changes: () => changes,
  };
}

/** The tenant's own chain: its audit rows, read in its unit. */
async function auditOf(r: Rig, scope: TenantScope) {
  return (
    await r.tenancy.db(scope).query<{
      action: string;
      actor_kind: string;
      target_kind: string;
      target_id: string;
      details: Record<string, unknown>;
    }>('select action, actor_kind, target_kind, target_id, details from audit_events order by at, id')
  ).rows;
}

describeDb('the lifecycle service (hosted spec §22.2)', () => {
  let r: Rig;
  beforeEach(async () => {
    r = await rig();
  });
  afterEach(async () => {
    await r.control.close();
    await r.db.close();
  });

  it('create makes the row and its data key in a control transaction, audits tenant.created, and tells the directory', async () => {
    const created = await r.lifecycle.create({
      slug: 'acme',
      name: 'Acme',
      edition: 'team',
      seats: 10,
      editionSource: 'operator',
    });
    expect(created).toMatchObject({
      slug: 'acme',
      edition: 'team',
      seats: 10,
      editionSource: 'operator',
      status: 'active',
      suspendedReason: null,
    });
    const key = await r.db.owner.query<{ has: boolean }>(
      'select data_key is not null as has from tenants where id = $1::uuid',
      [created.id],
    );
    expect(key.rows[0]?.has).toBe(true);
    expect(await auditOf(r, created.scope)).toMatchObject([
      {
        action: 'tenant.created',
        actor_kind: 'system',
        target_kind: 'tenant',
        target_id: created.id,
        details: { slug: 'acme', edition: 'team', seats: 10, editionSource: 'operator', by: 'operator' },
      },
    ]);
    expect(r.changes()).toBe(1);
  });

  it('create refuses community, bad seats, an invalid or reserved slug', async () => {
    const base = { slug: 'acme', name: 'Acme', edition: 'team' as const, editionSource: 'operator' as const };
    await expect(r.lifecycle.create({ ...base, edition: 'community' as never })).rejects.toMatchObject({
      code: 'control-plane-edition-invalid',
    });
    await expect(r.lifecycle.create({ ...base, seats: 0 })).rejects.toMatchObject({
      code: 'control-plane-seats-invalid',
    });
    await expect(r.lifecycle.create({ ...base, slug: 'Acme!' })).rejects.toMatchObject({
      code: 'tenancy-slug-invalid',
    });
    await expect(r.lifecycle.create({ ...base, slug: 'billing' })).rejects.toMatchObject({
      code: 'tenancy-slug-reserved',
    });
    expect(r.changes()).toBe(0);
  });

  it('a slug held by a tenant, an open signup or a retired slug is refused; a completed signup frees it', async () => {
    await r.lifecycle.create({ slug: 'acme', name: 'Acme', edition: 'team', editionSource: 'operator' });
    const signup = (slug: string, status: string) =>
      r.control.query(
        `insert into signups (id, email_lower, name, slug, seats, token_hash, status, expires_at)
         values ($1::uuid, 'a@example.com', 'A', $2, 1, $3, $4, now() + interval '1 day')`,
        [randomUUID(), slug, randomUUID(), status],
      );
    await signup('pending-co', 'pending');
    await signup('paid-co', 'verified');
    await signup('done-co', 'completed');
    await r.control.query(`insert into tenant_slugs_retired (slug, tenant_id) values ('old-co', $1::uuid)`, [
      randomUUID(),
    ]);
    for (const slug of ['acme', 'pending-co', 'paid-co', 'old-co']) {
      await expect(
        r.lifecycle.create({ slug, name: slug, edition: 'team', editionSource: 'operator' }),
        slug,
      ).rejects.toMatchObject({ code: 'control-plane-slug-taken' });
    }
    await r.lifecycle.create({ slug: 'done-co', name: 'Done', edition: 'team', editionSource: 'operator' });
    expect(await r.control.transaction((tx) => slugState(tx, 'fresh-co'))).toBe('ok');
  });

  it('two concurrent creates of one slug: one wins, the other is refused', async () => {
    // The first holds the slug lock until it is let go; the second waits on it, then finds the first's row.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const blocker = r.control.transaction(async (tx) => {
      await tx.query(SLUG_LOCK);
      await held;
    });
    const outcomes = Promise.allSettled([
      r.lifecycle.create({ slug: 'race', name: 'One', edition: 'team', editionSource: 'operator' }),
      r.lifecycle.create({ slug: 'race', name: 'Two', edition: 'team', editionSource: 'operator' }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    release();
    await blocker;
    const settled = await outcomes;
    expect(settled.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect((settled.find((outcome) => outcome.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({
      code: 'control-plane-slug-taken',
    });
    expect((await r.control.query('select 1 from tenants where slug = $1', ['race'])).rows).toHaveLength(1);
  });

  it('setEdition: the operator’s edition and seats, or back to the subscription’s', async () => {
    const created = await r.lifecycle.create({
      slug: 'acme',
      name: 'Acme',
      edition: 'team',
      seats: 5,
      editionSource: 'subscription',
    });
    expect(await r.lifecycle.setEdition('acme', { edition: 'enterprise' })).toMatchObject({
      edition: 'enterprise',
      seats: 5,
      editionSource: 'operator',
    });
    expect(await r.lifecycle.setEdition('acme', { edition: 'enterprise', seats: 200 })).toMatchObject({ seats: 200 });
    await expect(r.lifecycle.setEdition('acme', { subscription: true })).rejects.toMatchObject({
      code: 'control-plane-no-subscription',
    });
    await r.tenancy.db(created.scope).query(
      `insert into subscriptions (provider, provider_ref, plan, seats, status, last_event_at)
       values ('paddle', 'sub_test_1', 'team', 12, 'active', now())`,
    );
    expect(await r.lifecycle.setEdition('acme', { subscription: true })).toMatchObject({
      edition: 'team',
      seats: 12,
      editionSource: 'subscription',
    });
    expect((await auditOf(r, created.scope)).map((row) => row.action)).toEqual([
      'tenant.created',
      'tenant.edition_set',
      'tenant.edition_set',
      'tenant.edition_set',
    ]);
    await expect(r.lifecycle.setEdition('nobody', { edition: 'team' })).rejects.toMatchObject({
      code: 'control-plane-tenant-unknown',
    });
    // The default tenant is no hosted tenant: its reserved slug names nothing here.
    await expect(r.lifecycle.setEdition('default', { edition: 'team' })).rejects.toMatchObject({
      code: 'control-plane-tenant-unknown',
    });
  });

  it('suspend and resume: the reason, its time, and resume clears both', async () => {
    const created = await r.lifecycle.create({
      slug: 'acme',
      name: 'Acme',
      edition: 'team',
      editionSource: 'operator',
    });
    const suspended = await r.lifecycle.suspend('acme');
    expect(suspended).toMatchObject({ status: 'suspended', suspendedReason: 'operator', suspendedAt: NOW });
    // The directory no longer resolves it.
    expect((await directoryOf(r.tenancy).resolvable()).map((scope) => scope.slug)).not.toContain('acme');
    expect(await r.lifecycle.resume('acme')).toMatchObject({
      status: 'active',
      suspendedReason: null,
      suspendedAt: null,
    });
    expect(await r.lifecycle.resume('acme')).toBeUndefined();
    expect(await auditOf(r, created.scope)).toMatchObject([
      { action: 'tenant.created' },
      { action: 'tenant.suspended', details: { reason: 'operator', by: 'operator' } },
      { action: 'tenant.resumed', details: { previousReason: 'operator' } },
    ]);
    // Created, suspended, resumed: three changes; the no-op resume told nobody.
    expect(r.changes()).toBe(3);
  });

  it('requestDeletion and cancelDeletion: 14 days on, by the operator, and cleared again', async () => {
    const created = await r.lifecycle.create({
      slug: 'acme',
      name: 'Acme',
      edition: 'team',
      editionSource: 'operator',
    });
    expect(await r.lifecycle.requestDeletion('acme')).toMatchObject({
      status: 'active',
      deletionRequestedAt: NOW,
      deletionRequestedBy: 'operator',
      deletingAt: new Date(NOW.getTime() + DELETION_DAYS * DAY_MS),
    });
    expect(await r.lifecycle.requestDeletion('acme')).toBeUndefined();
    expect(await r.lifecycle.cancelDeletion('acme')).toMatchObject({
      deletionRequestedAt: null,
      deletionRequestedBy: null,
      deletingAt: null,
    });
    expect(await r.lifecycle.cancelDeletion('acme')).toBeUndefined();
    expect((await auditOf(r, created.scope)).map((row) => row.action)).toEqual([
      'tenant.created',
      'tenant.deletion_requested',
      'tenant.deletion_cancelled',
    ]);
    // Once its job has started, nothing more changes it.
    await r.control.query("update tenants set status = 'deleting' where slug = 'acme'");
    for (const verb of [
      () => r.lifecycle.suspend('acme'),
      () => r.lifecycle.cancelDeletion('acme'),
      () => r.lifecycle.setEdition('acme', { edition: 'team' }),
    ]) {
      await expect(verb()).rejects.toMatchObject({ code: 'control-plane-tenant-deleting' });
    }
  });

  it('list shows every hosted tenant with its subscription status, never the default one', async () => {
    const created = await r.lifecycle.create({
      slug: 'acme',
      name: 'Acme',
      edition: 'team',
      editionSource: 'operator',
    });
    await r.lifecycle.create({ slug: 'bigco', name: 'Big', edition: 'enterprise', editionSource: 'operator' });
    await r.tenancy.db(created.scope).query(
      `insert into subscriptions (provider, provider_ref, plan, seats, status, last_event_at)
       values ('paddle', 'sub_test_1', 'team', 12, 'past_due', now())`,
    );
    expect(await r.lifecycle.list()).toMatchObject([
      { slug: 'acme', subscriptionStatus: 'past_due' },
      { slug: 'bigco', subscriptionStatus: null },
    ]);
  });

  it('records the actor it is given: a server admin’s deletion request is theirs', async () => {
    const created = await r.lifecycle.create({
      slug: 'acme',
      name: 'Acme',
      edition: 'team',
      editionSource: 'operator',
    });
    const userId = randomUUID();
    await r.lifecycle.requestDeletion('acme', {
      source: { actor: { kind: 'user', userId, email: 'admin@example.com' } },
      by: userId,
    });
    expect(
      (
        await r.control.query<{ by: string }>('select deletion_requested_by as by from tenants where slug = $1', [
          'acme',
        ])
      ).rows[0]?.by,
    ).toBe(userId);
    expect((await auditOf(r, created.scope)).at(-1)).toMatchObject({ actor_kind: 'user', details: { by: userId } });
  });
});

const log = Fastify({ logger: false }).log;
const APP_DOMAIN = 'example.test';
const hosted = (config: ServerConfig): ServerConfig => ({ ...config, mode: 'hosted', appDomain: APP_DOMAIN });

describeDb('the lifecycle announces over the bus (spec §20.3)', () => {
  let db: TestDatabase;
  let dataDir: string;
  const closers: (() => Promise<void>)[] = [];
  beforeEach(async () => {
    db = await testDatabase();
    await ensureControlRole(db.owner, db.controlUrl, db.url);
    dataDir = await mkTempDir();
  });
  afterEach(async () => {
    for (const close of closers.splice(0).reverse()) await close();
    await db.close();
    await removeTempDir(dataDir);
  });

  const node = async (): Promise<{ h: IdentityHarness; resolver: TenantResolver }> => {
    const holder = randomUUID();
    const registry = new InstanceRegistry({
      db,
      holder,
      mode: 'multi',
      url: 'http://127.0.0.1:1',
      version: '0.0.0-test',
      setTimer: manualTimers().setTimer,
      log: () => undefined,
    });
    await registry.start();
    const signals = new BusSignals();
    let resolver: TenantResolver | undefined;
    const h = await identityHarness({
      db,
      dataDir,
      env: { WIREBENCH_SERVER_SECRETS_KEY: ROOT.toString('base64') },
      configure: hosted,
      instance: registry,
      bus: signals,
      onTenantResolver: (made) => {
        resolver = made;
      },
    });
    const bus = new NotificationBus({
      db,
      holder,
      hooks: h.hooks,
      open: () => openSession(db.url, { applicationName: 'wirebench-test-bus' }),
      scopeFor: async (tenantId) => (await directoryOf(h.ctx.tenancy).get(tenantId))?.scope,
      log,
      retryDelayMs: 50,
      maxRetryDelayMs: 200,
    });
    signals.attach(bus);
    await bus.start();
    closers.push(async () => {
      await h.close();
      await bus.stop(0);
      await registry.stop();
    });
    return { h, resolver: resolver! };
  };

  it('a tenant created and suspended on one instance resolves, then stops resolving, on the other', async () => {
    const a = await node();
    const b = await node();
    const control = openControlDb(db.controlUrl);
    closers.push(() => control.close());
    const lifecycle = new TenantLifecycle({ control, tenancy: a.h.ctx.tenancy, hooks: a.h.hooks });
    const created = await lifecycle.create({ slug: 'acme', name: 'Acme', edition: 'team', editionSource: 'operator' });
    // This process's map reloads through the directory's own change.
    await vi.waitFor(() => expect(a.resolver.resolve(`acme.${APP_DOMAIN}`)?.tenantId).toBe(created.id), {
      timeout: 2_000,
      interval: 20,
    });
    await vi.waitFor(() => expect(b.resolver.resolve(`acme.${APP_DOMAIN}`)?.tenantId).toBe(created.id), {
      timeout: 2_000,
      interval: 20,
    });
    await lifecycle.suspend('acme');
    await vi.waitFor(() => expect(b.resolver.resolve(`acme.${APP_DOMAIN}`)).toBeUndefined(), {
      timeout: 2_000,
      interval: 20,
    });
  });
});
