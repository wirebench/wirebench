/**
 * Applying billing events (hosted edition spec §22.5; slice 7 Task 13): `billing_events` first, so a replay is a
 * no-op; an older event recorded and not applied; an `operator` edition untouched; a ref another tenant holds
 * refused; `deleted` and `paused` suspending `canceled`; `active` resuming. Suspensions and resumptions go through the
 * lifecycle, with `by: 'billing'` in the tenant's own audit chain.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { auditHook } from '../../../src/audit-log/hook.js';
import { serverHooks, type ServerHooks } from '../../../src/context.js';
import { applySubscriptionEvent, recordUnapplied, type ApplyDeps } from '../../../src/control-plane/billing/apply.js';
import type { SubscriptionEvent } from '../../../src/control-plane/billing/events.js';
import { openControlDb, type ControlDb } from '../../../src/control-plane/control-db.js';
import { TenantLifecycle } from '../../../src/control-plane/tenants.js';
import { environmentKeyRoot } from '../../../src/tenancy/keys.js';
import { ensureControlRole } from '../../../src/tenancy/roles.js';
import type { TenantScope } from '../../../src/tenancy/scope.js';
import { createTenancy, type Tenancy } from '../../../src/tenancy/tenancy.js';
import { describeDb, testDatabase, type TestDatabase } from '../../helpers/database.js';

const ROOT = Buffer.alloc(32, 7);
const NOW = new Date('2026-11-04T12:00:00.000Z');
const at = (minutes: number): Date => new Date(NOW.getTime() + minutes * 60_000);

interface Rig {
  readonly db: TestDatabase;
  readonly control: ControlDb;
  readonly tenancy: Tenancy;
  readonly hooks: ServerHooks;
  readonly lifecycle: TenantLifecycle;
  readonly deps: ApplyDeps;
  readonly log: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
}

async function rig(): Promise<Rig> {
  const db = await testDatabase();
  await ensureControlRole(db.owner, db.controlUrl, db.url);
  const control = openControlDb(db.controlUrl);
  const tenancy = createTenancy(db, { keyRoot: environmentKeyRoot(ROOT) });
  const hooks = serverHooks();
  let tick = 0;
  hooks.audit.push(auditHook(() => new Date(NOW.getTime() + 1_000 * tick++)));
  const lifecycle = new TenantLifecycle({ control, tenancy, hooks, now: () => NOW });
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { db, control, tenancy, hooks, lifecycle, log, deps: { control, tenancy, lifecycle, log } };
}

let seq = 0;
function event(overrides: Partial<SubscriptionEvent> = {}): SubscriptionEvent {
  seq += 1;
  return {
    provider: 'paddle',
    eventId: `evt_test_${String(seq)}`,
    eventType: 'subscription.updated',
    kind: 'updated',
    ref: 'sub_test_a',
    customerRef: 'ctm_test_a',
    status: 'active',
    seats: 5,
    periodEnd: new Date('2026-12-04T12:00:00.000Z'),
    occurredAt: at(seq),
    ...overrides,
  };
}

describeDb('applying billing events (hosted spec §22.5)', () => {
  let r: Rig;
  beforeEach(async () => {
    r = await rig();
  });
  afterEach(async () => {
    await r.control.close();
    await r.db.close();
  });

  const team = (slug: string, editionSource: 'subscription' | 'operator' = 'subscription') =>
    r.lifecycle.create({
      slug,
      name: `Team ${slug}`,
      edition: editionSource === 'operator' ? 'enterprise' : 'team',
      seats: editionSource === 'operator' ? 50 : 1,
      editionSource,
    });
  const tenantOf = async (slug: string) => (await r.lifecycle.list()).find((row) => row.slug === slug)!;
  const subscriptionOf = async (scope: TenantScope) =>
    (
      await r.tenancy.db(scope).query<{
        provider_ref: string;
        seats: number;
        status: string;
        past_due_since: Date | null;
        last_event_at: Date;
      }>('select provider_ref, seats, status, past_due_since, last_event_at from subscriptions')
    ).rows[0];
  const outcomeOf = async (eventId: string) =>
    (await r.db.owner.query<{ outcome: string }>('select outcome from billing_events where event_id = $1', [eventId]))
      .rows[0]?.outcome;
  const audit = async (scope: TenantScope) =>
    (
      await r.tenancy
        .db(scope)
        .query<{ action: string; details: Record<string, unknown> }>(
          'select action, details from audit_events order by at, id',
        )
    ).rows;

  it('attaches a created subscription to its tenant: team, its seats, recorded applied', async () => {
    const a = await team('acme');
    const created = event({ kind: 'created', eventType: 'subscription.created', tenant: a.id });
    expect(await applySubscriptionEvent(r.deps, created)).toBe('applied');
    expect(await outcomeOf(created.eventId)).toBe('applied');
    expect(await subscriptionOf(a.scope)).toMatchObject({ provider_ref: 'sub_test_a', seats: 5, status: 'active' });
    expect(await tenantOf('acme')).toMatchObject({ edition: 'team', seats: 5, subscriptionStatus: 'active' });
    expect((await audit(a.scope)).map((row) => row.action)).toEqual(['tenant.created', 'tenant.edition_set']);
    expect((await audit(a.scope))[1]!.details).toMatchObject({ seats: 5, by: 'billing' });
  });

  it('is a no-op on a replay: duplicate, nothing written twice', async () => {
    const a = await team('acme');
    const created = event({ kind: 'created', tenant: a.id });
    await applySubscriptionEvent(r.deps, created);
    const before = await audit(a.scope);
    expect(await applySubscriptionEvent(r.deps, { ...created, seats: 9 })).toBe('duplicate');
    expect((await subscriptionOf(a.scope))?.seats).toBe(5);
    expect(await audit(a.scope)).toEqual(before);
    const rows = await r.db.owner.query('select 1 from billing_events where event_id = $1', [created.eventId]);
    expect(rows.rows).toHaveLength(1);
  });

  it('records an event older than the last applied one, and applies nothing of it', async () => {
    const a = await team('acme');
    const older = event({ seats: 9, tenant: a.id });
    const newer = event({ seats: 5, tenant: a.id });
    expect(await applySubscriptionEvent(r.deps, newer)).toBe('applied');
    expect(await applySubscriptionEvent(r.deps, older)).toBe('stale');
    expect(await outcomeOf(older.eventId)).toBe('stale');
    expect(await subscriptionOf(a.scope)).toMatchObject({ seats: 5, last_event_at: newer.occurredAt });
    expect((await tenantOf('acme')).seats).toBe(5);
  });

  it("records the subscription of an operator's tenant and leaves its edition alone", async () => {
    const a = await team('acme', 'operator');
    const updated = event({ tenant: a.id, status: 'canceled', kind: 'deleted' });
    expect(await applySubscriptionEvent(r.deps, updated)).toBe('not-applied');
    expect(await subscriptionOf(a.scope)).toMatchObject({ status: 'canceled' });
    expect(await tenantOf('acme')).toMatchObject({ edition: 'enterprise', seats: 50, status: 'active' });
    expect(r.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: a.id, editionSource: 'operator' }),
      expect.any(String),
    );
  });

  it('refuses a subscription another tenant holds, and never moves it', async () => {
    const a = await team('acme');
    const b = await team('beta');
    await applySubscriptionEvent(r.deps, event({ kind: 'created', tenant: a.id }));
    const stolen = event({ kind: 'created', tenant: b.id, seats: 40 });
    expect(await applySubscriptionEvent(r.deps, stolen)).toBe('billing-ref-conflict');
    expect(await outcomeOf(stolen.eventId)).toBe('billing-ref-conflict');
    expect(await subscriptionOf(b.scope)).toBeUndefined();
    expect((await subscriptionOf(a.scope))?.seats).toBe(5);
    expect(r.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'billing-ref-conflict', tenantId: b.id, heldBy: [a.id] }),
      expect.any(String),
    );
  });

  it('suspends canceled on deleted, and on paused; resumes on active', async () => {
    const a = await team('acme');
    await applySubscriptionEvent(r.deps, event({ kind: 'created', tenant: a.id }));
    // Later events carry no tenant: the subscription's ref finds it.
    expect(await applySubscriptionEvent(r.deps, event({ kind: 'deleted', status: 'canceled' }))).toBe('applied');
    expect(await tenantOf('acme')).toMatchObject({ status: 'suspended', suspendedReason: 'canceled' });
    expect(await applySubscriptionEvent(r.deps, event({ status: 'active' }))).toBe('applied');
    expect(await tenantOf('acme')).toMatchObject({ status: 'active', suspendedReason: null });
    expect(await applySubscriptionEvent(r.deps, event({ status: 'paused' }))).toBe('applied');
    expect(await tenantOf('acme')).toMatchObject({ status: 'suspended', suspendedReason: 'canceled' });
    const rows = (await audit(a.scope)).filter((row) => row.action !== 'tenant.edition_set');
    expect(rows.map((row) => [row.action, row.details.by])).toEqual([
      ['tenant.created', 'operator'],
      ['tenant.suspended', 'billing'],
      ['tenant.resumed', 'billing'],
      ['tenant.suspended', 'billing'],
    ]);
  });

  it('resumes a tenant suspended unpaid, never one the operator suspended', async () => {
    const a = await team('acme');
    await applySubscriptionEvent(r.deps, event({ kind: 'created', tenant: a.id }));
    await r.lifecycle.suspend('acme', 'unpaid');
    await applySubscriptionEvent(r.deps, event({ status: 'active' }));
    expect((await tenantOf('acme')).status).toBe('active');
    await r.lifecycle.suspend('acme', 'operator');
    await applySubscriptionEvent(r.deps, event({ status: 'active' }));
    expect(await tenantOf('acme')).toMatchObject({ status: 'suspended', suspendedReason: 'operator' });
    await applySubscriptionEvent(r.deps, event({ status: 'canceled', kind: 'deleted' }));
    expect((await tenantOf('acme')).suspendedReason).toBe('operator');
  });

  it('sets past_due_since once, and clears it on a payment', async () => {
    const a = await team('acme');
    await applySubscriptionEvent(r.deps, event({ kind: 'created', tenant: a.id }));
    const first = event({ status: 'past_due' });
    await applySubscriptionEvent(r.deps, first);
    await applySubscriptionEvent(r.deps, event({ status: 'past_due' }));
    expect((await subscriptionOf(a.scope))?.past_due_since).toEqual(first.occurredAt);
    expect((await tenantOf('acme')).status).toBe('active');
    await applySubscriptionEvent(r.deps, event({ status: 'active' }));
    expect((await subscriptionOf(a.scope))?.past_due_since).toBeNull();
  });

  it('leaves a signup to Part E, and records an event it cannot place as unmatched', async () => {
    const signup = event({ kind: 'created', signup: '5d2a8e41-0b7f-4a3c-8e19-6f0c2b9d4e57', ref: 'sub_test_s' });
    expect(await applySubscriptionEvent(r.deps, signup)).toBe('signup-pending');
    expect(await outcomeOf(signup.eventId)).toBe('signup-pending');
    const nobody = event({ ref: 'sub_test_nobody' });
    expect(await applySubscriptionEvent(r.deps, nobody)).toBe('unmatched');
    expect(await applySubscriptionEvent(r.deps, event({ tenant: '00000000-0000-4000-8000-000000000000' }))).toBe(
      'unmatched',
    );
    expect(await applySubscriptionEvent(r.deps, event({ tenant: 'not-a-uuid' }))).toBe('unmatched');
    expect((await r.lifecycle.list()).length).toBe(0);
  });

  it('records an unapplied event once', async () => {
    const ignored = {
      provider: 'paddle',
      eventId: 'evt_test_ignored',
      eventType: 'transaction.completed',
      occurredAt: NOW,
      outcome: 'ignored',
    } as const;
    expect(await recordUnapplied(r.deps, ignored)).toBe('ignored');
    expect(await recordUnapplied(r.deps, ignored)).toBe('duplicate');
    expect(await outcomeOf('evt_test_ignored')).toBe('ignored');
  });

  it('rolls the event back when the subscription write fails, so a retry applies it', async () => {
    const a = await team('acme');
    const created = event({ kind: 'created', tenant: a.id });
    const failing: ApplyDeps = {
      ...r.deps,
      tenancy: {
        db: () => {
          throw Object.assign(new Error('the database went away'), { code: '57P01' });
        },
      },
    };
    await expect(applySubscriptionEvent(failing, created)).rejects.toThrow();
    expect(await outcomeOf(created.eventId)).toBeUndefined();
    expect(await applySubscriptionEvent(r.deps, created)).toBe('applied');
  });
});
