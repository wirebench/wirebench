/**
 * The control loop (hosted edition spec §22.5, §22.15; slice 7 Task 14), with an injected clock: the grace sweep
 * suspends `unpaid` on day 14 and a payment before stops it; each mail goes once; a failing step leaves the others
 * running; the loop lock lets one instance run a pass at a time; old `billing_events` rows are deleted; a cancel
 * recorded under another suspension suspends `canceled` once that one is lifted.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest';
import { auditHook } from '../../../src/audit-log/hook.js';
import { serverHooks } from '../../../src/context.js';
import { applySubscriptionEvent, type ApplyDeps } from '../../../src/control-plane/billing/apply.js';
import type { SubscriptionEvent } from '../../../src/control-plane/billing/events.js';
import { billingEventsRetentionStep, DAY_MS, graceSweepStep } from '../../../src/control-plane/billing/sweep.js';
import { openControlDb, type ControlDb } from '../../../src/control-plane/control-db.js';
import { CONTROL_LOOP_LOCK, CONTROL_LOOP_MS, ControlLoop, type LoopStep } from '../../../src/control-plane/loop.js';
import { mailStep, type ControlMail } from '../../../src/control-plane/mail.js';
import { TenantLifecycle } from '../../../src/control-plane/tenants.js';
import { environmentKeyRoot } from '../../../src/tenancy/keys.js';
import { ensureControlRole } from '../../../src/tenancy/roles.js';
import type { TenantScope } from '../../../src/tenancy/scope.js';
import { createTenancy, type Tenancy } from '../../../src/tenancy/tenancy.js';
import { describeDb, testDatabase, type TestDatabase } from '../../helpers/database.js';
import { manualTimers } from '../../helpers/timers.js';

const ROOT = Buffer.alloc(32, 7);
const T0 = new Date('2026-11-04T12:00:00.000Z');
const days = (n: number): Date => new Date(T0.getTime() + n * DAY_MS);

interface Sent {
  readonly to: readonly string[];
  readonly mail: ControlMail;
}

describeDb('the control loop (hosted spec §22.15)', () => {
  let db: TestDatabase;
  let control: ControlDb;
  let tenancy: Tenancy;
  let lifecycle: TenantLifecycle;
  let deps: ApplyDeps;
  let now: Date;
  let sent: Sent[];
  type LogFn = (...args: unknown[]) => void;
  let log: { info: Mock<LogFn>; warn: Mock<LogFn>; error: Mock<LogFn> };
  let seq = 0;

  beforeEach(async () => {
    db = await testDatabase();
    await ensureControlRole(db.owner, db.controlUrl, db.url);
    control = openControlDb(db.controlUrl);
    tenancy = createTenancy(db, { keyRoot: environmentKeyRoot(ROOT) });
    const hooks = serverHooks();
    hooks.audit.push(auditHook(() => now));
    now = T0;
    lifecycle = new TenantLifecycle({ control, tenancy, hooks, now: () => now });
    log = { info: vi.fn<LogFn>(), warn: vi.fn<LogFn>(), error: vi.fn<LogFn>() };
    deps = { control, tenancy, lifecycle, log };
    sent = [];
  });
  afterEach(async () => {
    await control.close();
    await db.close();
  });

  const loopWith = (steps?: readonly LoopStep[]) =>
    new ControlLoop({
      control,
      log,
      now: () => now,
      steps: steps ?? [
        graceSweepStep(lifecycle),
        mailStep({
          tenancy,
          lifecycle,
          config: { mode: 'hosted', appDomain: 'app.test' },
          send: (to, mail) => {
            sent.push({ to, mail });
            return Promise.resolve();
          },
          log,
          mailHost: 'mail.test',
        }),
        billingEventsRetentionStep(),
      ],
    });

  const event = (overrides: Partial<SubscriptionEvent>): SubscriptionEvent => {
    seq += 1;
    return {
      provider: 'paddle',
      eventId: `evt_test_loop_${String(seq)}`,
      eventType: 'subscription.updated',
      kind: 'updated',
      ref: 'sub_test_loop',
      customerRef: null,
      status: 'active',
      seats: 3,
      periodEnd: null,
      occurredAt: now,
      ...overrides,
    };
  };

  /** A `created` for a signup row bound to `tenantId` (spec §22.5). */
  const createdFor = async (tenantId: string, overrides: Partial<SubscriptionEvent> = {}) => {
    const signup = randomUUID();
    await db.owner.query(
      `insert into signups (id, email_lower, name, slug, seats, token_hash, status, tenant_id, expires_at)
       values ($1::uuid, 'owner@acme.test', 'Acme', $2, 1, $3, 'verified', $4::uuid, $5::timestamptz)`,
      [signup, `s-${signup.slice(0, 8)}`, `hash-${signup}`, tenantId, days(1)],
    );
    return event({ kind: 'created', signup, ...overrides });
  };

  /** A subscribed team with one server admin (and one who is not), past due from T0. */
  const pastDueTeam = async (): Promise<{ id: string; scope: TenantScope }> => {
    const made = await lifecycle.create({
      slug: 'acme',
      name: 'Acme <b>Ops</b>\nTeam',
      edition: 'team',
      editionSource: 'subscription',
    });
    for (const [email, admin] of [
      ['admin@acme.test', true],
      ['member@acme.test', false],
    ] as const) {
      await tenancy
        .db(made.scope)
        .query(
          'insert into users (id, email, email_lower, display_name, server_admin, created_at) values ($1, $2, $2, $2, $3, $4)',
          [randomUUID(), email, admin, T0],
        );
    }
    await applySubscriptionEvent(deps, await createdFor(made.id, { occurredAt: days(-30) }));
    await applySubscriptionEvent(deps, event({ status: 'past_due', occurredAt: T0 }));
    return { id: made.id, scope: made.scope };
  };
  const statusOf = async (id: string) =>
    (
      await db.owner.query<{ status: string; suspended_reason: string | null }>(
        'select status, suspended_reason from tenants where id = $1',
        [id],
      )
    ).rows[0];

  it('suspends unpaid on day 14 of past due, not before, and audits it by billing', async () => {
    const { id, scope } = await pastDueTeam();
    const loop = loopWith();
    now = new Date(days(14).getTime() - 60_000);
    expect(await loop.pass()).toBe(true);
    expect(await statusOf(id)).toEqual({ status: 'active', suspended_reason: null });
    now = days(14);
    await loop.pass();
    expect(await statusOf(id)).toEqual({ status: 'suspended', suspended_reason: 'unpaid' });
    const audit = await tenancy
      .db(scope)
      .query<{ action: string; details: Record<string, unknown> }>(
        "select action, details from audit_events where action = 'tenant.suspended'",
      );
    expect(audit.rows).toEqual([
      { action: 'tenant.suspended', details: expect.objectContaining({ reason: 'unpaid', by: 'billing' }) as unknown },
    ]);
  });

  it('stops the sweep when a payment comes first, and resumes a tenant it suspended', async () => {
    const { id } = await pastDueTeam();
    const loop = loopWith();
    now = days(13);
    await applySubscriptionEvent(deps, event({ status: 'active' }));
    now = days(20);
    await loop.pass();
    expect((await statusOf(id))?.status).toBe('active');
    await applySubscriptionEvent(deps, event({ status: 'past_due' }));
    now = days(34);
    await loop.pass();
    expect(await statusOf(id)).toEqual({ status: 'suspended', suspended_reason: 'unpaid' });
    now = days(35);
    await applySubscriptionEvent(deps, event({ status: 'active' }));
    expect((await statusOf(id))?.status).toBe('active');
  });

  it('suspends canceled a tenant whose cancel came while the operator had it suspended, once resumed', async () => {
    const made = await lifecycle.create({ slug: 'acme', name: 'Acme', edition: 'team', editionSource: 'subscription' });
    await applySubscriptionEvent(deps, await createdFor(made.id, { occurredAt: days(-1) }));
    await lifecycle.suspend('acme', 'operator');
    await applySubscriptionEvent(deps, event({ kind: 'deleted', status: 'canceled' }));
    expect(await statusOf(made.id)).toEqual({ status: 'suspended', suspended_reason: 'operator' });
    await lifecycle.resume('acme');
    expect(await statusOf(made.id)).toEqual({ status: 'active', suspended_reason: null });
    const loop = loopWith([graceSweepStep(lifecycle)]);
    await loop.pass();
    expect(await statusOf(made.id)).toEqual({ status: 'suspended', suspended_reason: 'canceled' });
    const audit = await tenancy
      .db(made.scope)
      .query<{ details: Record<string, unknown> }>(
        "select details from audit_events where action = 'tenant.suspended' order by at desc, id desc limit 1",
      );
    expect(audit.rows[0]?.details).toMatchObject({ reason: 'canceled', by: 'billing' });
    // An operator's edition keeps its tenant running whatever the subscription says.
    await lifecycle.resume('acme');
    await lifecycle.setEdition('acme', { edition: 'enterprise' });
    await loop.pass();
    expect((await statusOf(made.id))?.status).toBe('active');
  });

  it('mails the server admins once each: past due, three days left, suspended', async () => {
    await pastDueTeam();
    const loop = loopWith();
    const kinds = () => sent.map((s) => s.mail.subject);
    now = days(0.01);
    await loop.pass();
    await loop.pass();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toEqual(['admin@acme.test']);
    expect(sent[0]!.mail.subject).toMatch(/overdue/);
    // The team's name as one line of plain text, and the sign-in link; nothing from Paddle.
    expect(sent[0]!.mail.text).toContain('"Acme <b>Ops</b> Team"');
    expect(sent[0]!.mail.text).toContain('Sign in: https://acme.app.test/sign-in');
    expect(sent[0]!.mail.text).toContain('2026-11-18');
    expect(JSON.stringify(sent)).not.toMatch(/sub_test|ctm_|evt_/);
    now = days(10.9);
    await loop.pass();
    expect(sent).toHaveLength(1);
    now = days(11);
    await loop.pass();
    now = days(12);
    await loop.pass();
    expect(kinds()).toHaveLength(2);
    expect(kinds()[1]).toMatch(/three days/);
    now = days(14);
    await loop.pass();
    now = days(15);
    await loop.pass();
    expect(kinds()).toHaveLength(3);
    expect(kinds()[2]).toMatch(/is suspended$/);
  });

  it('sends the warning alone to a tenant first seen inside its last three days', async () => {
    await pastDueTeam();
    now = days(12);
    await loopWith().pass();
    await loopWith().pass();
    expect(sent.map((s) => s.mail.subject)).toEqual([expect.stringMatching(/three days/)]);
  });

  it('keeps running the other steps when one fails, and logs the step', async () => {
    await db.owner.query(
      `insert into billing_events (provider, event_id, event_type, occurred_at, received_at, outcome) values
       ('paddle', 'evt_test_old', 'subscription.updated', $1, $1, 'applied'),
       ('paddle', 'evt_test_recent', 'subscription.updated', $2, $2, 'applied')`,
      [days(-91), days(-89)],
    );
    const broken: LoopStep = {
      name: 'broken',
      run: async ({ tx }) => {
        await tx.query('select * from no_such_table');
      },
    };
    const brokenTenant: LoopStep = {
      name: 'broken-tenant',
      run: async ({ each }) => {
        await each('00000000-0000-4000-8000-000000000001', () => Promise.reject(new Error('one tenant')));
      },
    };
    await loopWith([broken, brokenTenant, billingEventsRetentionStep()]).pass();
    const left = await db.owner.query<{ event_id: string }>('select event_id from billing_events order by event_id');
    expect(left.rows.map((row) => row.event_id)).toEqual(['evt_test_recent']);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ step: 'broken', reason: '42P01' }),
      expect.any(String),
    );
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ step: 'broken-tenant', tenantId: '00000000-0000-4000-8000-000000000001' }),
      expect.any(String),
    );
  });

  it('runs a pass on one instance at a time', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const other = control.transaction(async (tx) => {
      await tx.query(CONTROL_LOOP_LOCK);
      locked();
      await held;
    });
    await isLocked;
    const ran: string[] = [];
    const loop = loopWith([{ name: 'mark', run: () => Promise.resolve(void ran.push('ran')) }]);
    expect(await loop.pass()).toBe(false);
    expect(ran).toEqual([]);
    release();
    await other;
    expect(await loop.pass()).toBe(true);
    expect(ran).toEqual(['ran']);
  });

  it('arms a pass every 60 s, and stops on close', async () => {
    const timers = manualTimers();
    let passes = 0;
    const loop = new ControlLoop({
      control,
      log,
      setTimer: timers.setTimer,
      steps: [{ name: 'count', run: () => Promise.resolve(void (passes += 1)) }],
    });
    loop.start();
    expect(timers.pending(CONTROL_LOOP_MS)).toBe(1);
    timers.fire(CONTROL_LOOP_MS);
    await vi.waitFor(() => {
      expect(timers.pending(CONTROL_LOOP_MS)).toBe(1);
    });
    expect(passes).toBe(1);
    await loop.close();
    expect(timers.pending(CONTROL_LOOP_MS)).toBe(0);
  });
});
