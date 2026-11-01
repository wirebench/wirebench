/**
 * Scheduled runs with two tenants under the forced policy (tenancy Task 18; Task 13's listed cases). The claim
 * queries (`claimDueSchedules`, `claimQueuedRuns`, the outbox claim) and the retention deletes have no tenant filter
 * of their own: a pass of one tenant's unit sees that tenant's rows only because the policy says so. Both tenants
 * have a workspace with the same id, so a run, an alert or a route can only stay apart by its tenant.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { CaptureSweeper } from '../../../../src/hooks/sweep.js';
import { newId } from '../../../../src/identity/tokens.js';
import { licensingModule } from '../../../../src/licensing/module.js';
import type { AlertOutbox, DeliverAlert } from '../../../../src/schedules/alerts/outbox.js';
import type { AlertPayload } from '../../../../src/schedules/alerts/render.js';
import { schedulesModule } from '../../../../src/schedules/module.js';
import * as repo from '../../../../src/schedules/repo.js';
import type { Scheduler } from '../../../../src/schedules/scheduler.js';
import { sealAlertTargets, type StoredAlertTarget } from '../../../../src/schedules/seal.js';
import { teamsModule } from '../../../../src/teams/module.js';
import * as teamsRepo from '../../../../src/teams/repo.js';
import { describeDb } from '../../../helpers/database.js';
import type { SignedInUser } from '../../../helpers/identity.js';
import { license, testKeys } from '../../../helpers/licensing.js';
import { quietLog, testSettings } from '../../../helpers/schedule-runs.js';
import { SCHEDULES_KEY } from '../../../helpers/schedules.js';
import { manualTimers } from '../../../helpers/timers.js';
import { countIn, twoTenants, type Tenant, type TwoTenants } from './two-tenants.js';

const keys = testKeys();
const DAY = 86_400_000;

interface Cast {
  readonly root: SignedInUser;
  readonly admin: SignedInUser;
}

describeDb('scheduled runs in two tenants (tenancy Task 18)', () => {
  let t: TwoTenants;
  const timers = manualTimers();
  /** The workspace id both tenants have. */
  const workspaceId = newId();
  const casts: Partial<Record<'acme' | 'beta', Cast>> = {};
  const cast = (tenant: Tenant) => casts[tenant.slug]!;
  let scheduler: Scheduler | undefined;
  let outbox: AlertOutbox | undefined;
  /** Every run the scheduler started, with the tenant it was started in. */
  const started: { readonly tenantId: string; readonly runId: string }[] = [];
  const deliveries: { readonly target: StoredAlertTarget; readonly payload: AlertPayload }[] = [];
  beforeAll(async () => {
    const deliver: DeliverAlert = (target, payload) => {
      deliveries.push({ target, payload });
      return Promise.resolve();
    };
    t = await twoTenants({
      env: { WIREBENCH_SERVER_SCHEDULES_SECRET_KEY: SCHEDULES_KEY, WIREBENCH_SERVER_SCHEDULES_CONCURRENCY: '8' },
      modules: (clock) => [
        licensingModule({ now: () => clock.now, publicKeys: [keys.publicKey] }),
        teamsModule({ now: () => clock.now }),
        schedulesModule({
          now: () => clock.now,
          setTimer: timers.setTimer,
          startScheduler: false,
          execute: (runId, _signal, scope) => {
            started.push({ tenantId: scope.tenantId, runId });
            return Promise.resolve();
          },
          onScheduler: (made) => {
            scheduler = made;
          },
          deliver,
          onOutbox: (made) => {
            outbox = made;
          },
        }),
      ],
    });
    for (const tenant of [t.a, t.b]) {
      const root = await tenant.user({ email: 'root@example.com', serverAdmin: true });
      const installed = await tenant.call(root, 'PUT', '/license', {
        license: license(keys, { edition: 'enterprise' }),
      });
      expect(installed.status).toBe(200);
      const admin = await tenant.user({ email: 'admin@example.com' });
      const team = await teamsRepo.insertTeam(tenant.tdb, { id: newId(), name: 'Ops', at: t.h.clock.now });
      await teamsRepo.insertMember(tenant.tdb, {
        teamId: team.id,
        userId: admin.user.id,
        role: 'admin',
        at: t.h.clock.now,
      });
      await teamsRepo.insertWorkspace(tenant.tdb, {
        id: workspaceId,
        name: `Smoke ${tenant.slug}`,
        teamId: team.id,
        defaultRole: 'viewer',
        createdBy: null,
        at: t.h.clock.now,
      });
      casts[tenant.slug] = { root, admin };
    }
  });
  afterAll(() => t.close());

  const seedSchedule = async (
    tenant: Tenant,
    input: { readonly due?: boolean; readonly alerts?: boolean } = {},
  ): Promise<string> => {
    const id = newId();
    await repo.insertSchedule(tenant.tdb, {
      id,
      workspaceId,
      name: `Nightly ${tenant.slug} ${id}`,
      cron: '0 3 * * *',
      timeZone: 'UTC',
      target: { project: 'Billing', environment: 'prod' },
      options: { timeoutMinutes: 15, allowProtected: false, insecureTls: false, bail: false },
      alerts:
        input.alerts === true
          ? {
              targets: sealAlertTargets(testSettings(), [
                { kind: 'webhook', url: `https://hooks.example.test/${tenant.slug}`, secret: `shh-${tenant.slug}` },
              ]),
              muteAfter: 3,
            }
          : { targets: [], muteAfter: 3 },
      enabled: true,
      nextRunAt: input.due === true ? new Date(t.h.clock.now.getTime() - 60_000) : null,
      createdBy: cast(tenant).admin.user.id,
      at: t.h.clock.now,
    });
    return id;
  };
  const runsOf = async (tenant: Tenant, scheduleId: string) =>
    (
      await tenant.tdb.query<{ id: string; status: string; reason: string | null }>(
        'select id, status, reason from schedule_runs where schedule_id = $1 order by queued_at, id',
        [scheduleId],
      )
    ).rows;

  it("due schedules in both tenants fire in one pass, each in its own unit, and each claimed run is its tenant's", async () => {
    const inA = await seedSchedule(t.a, { due: true });
    const inB = await seedSchedule(t.b, { due: true });
    started.length = 0;
    const pass = await scheduler!.runOnce();
    expect(pass.fired).toBe(2);
    expect(pass.started).toBe(2);
    const [runA] = await runsOf(t.a, inA);
    const [runB] = await runsOf(t.b, inB);
    expect(runA).toBeDefined();
    expect(runB).toBeDefined();
    // Each run is in its own tenant only, and was started in that tenant's turn.
    expect(await countIn(t.a, 'schedule_runs', 'id = $1', [runB!.id])).toBe(0);
    expect(await countIn(t.b, 'schedule_runs', 'id = $1', [runA!.id])).toBe(0);
    expect(started).toEqual(
      expect.arrayContaining([
        { tenantId: t.a.scope.tenantId, runId: runA!.id },
        { tenantId: t.b.scope.tenantId, runId: runB!.id },
      ]),
    );
    expect(started).toHaveLength(2);
    await scheduler!.idle();
  });

  it("B cannot read, run, cancel, edit or delete A's schedule or run by id on B's host", async () => {
    const scheduleId = await seedSchedule(t.a);
    const runId = newId();
    await repo.insertRun(t.a.tdb, { id: runId, scheduleId, trigger: 'manual', status: 'queued', at: t.h.clock.now });
    const base = `/workspaces/${workspaceId}/schedules/${scheduleId}`;
    const refused = [
      ['GET', base, undefined],
      ['PATCH', base, { name: 'Taken over' }],
      ['PUT', `${base}/secrets`, { API_KEY: 'planted' }],
      ['POST', `${base}/alerts/test`, undefined],
      ['GET', `${base}/runs`, undefined],
      ['POST', `${base}/runs`, undefined],
      ['GET', `${base}/runs/${runId}`, undefined],
      ['DELETE', `${base}/runs/${runId}`, undefined],
      ['DELETE', base, undefined],
    ] as const;
    for (const [method, path, payload] of refused) {
      const res = await t.b.call<{ code: string }>(cast(t.b).admin, method, path, payload);
      expect(res.status, `${method} ${path}: ${JSON.stringify(res.body)}`).toBe(404);
      expect(res.body.code, `${method} ${path}`).toBe('schedules-not-found');
    }
    const listed = await t.b.call<{ id: string }[]>(cast(t.b).admin, 'GET', `/workspaces/${workspaceId}/schedules`);
    expect(listed.status).toBe(200);
    expect(JSON.stringify(listed.body)).not.toContain(scheduleId);
    // A's schedule and run are as they were.
    expect((await repo.scheduleById(t.a.tdb, workspaceId, scheduleId))?.name).toContain('acme');
    expect((await runsOf(t.a, scheduleId)).map((run) => run.status)).toEqual(['queued']);
    // And A's admin, on A's host, reaches each read (the writes' positive controls are Task 19's route sweep).
    for (const [method, path] of refused.filter(([method]) => method === 'GET')) {
      expect((await t.a.call(cast(t.a).admin, method, path)).status, `A ${path}`).toBe(200);
    }
  });

  it('interrupted runs end in both tenants, and each alert is claimed and delivered in its own turn, with its link', async () => {
    const long = new Date(t.h.clock.now.getTime() - 60 * 60_000);
    const seeded = [];
    for (const tenant of [t.a, t.b]) {
      const scheduleId = await seedSchedule(tenant, { alerts: true });
      const runId = newId();
      await repo.insertRun(tenant.tdb, { id: runId, scheduleId, trigger: 'schedule', status: 'running', at: long });
      seeded.push({ tenant, scheduleId, runId });
    }
    deliveries.length = 0;
    await scheduler!.runOnce();
    for (const { tenant, scheduleId, runId } of seeded) {
      expect(await runsOf(tenant, scheduleId)).toEqual([{ id: runId, status: 'errored', reason: 'interrupted' }]);
      expect(await countIn(tenant, 'schedule_alert_outbox', 'run_id = $1', [runId])).toBe(1);
    }
    await outbox!.runOnce();
    expect(deliveries).toHaveLength(2);
    for (const { tenant, scheduleId, runId } of seeded) {
      const delivered = deliveries.find((delivery) => delivery.payload.schedule.id === scheduleId)!;
      expect(delivered.payload.run?.id).toBe(runId);
      expect(delivered.payload.run?.url.startsWith(`${tenant.origin}/api/v1/workspaces/${workspaceId}/`)).toBe(true);
      expect(delivered.payload.workspace.name).toBe(`Smoke ${tenant.slug}`);
      expect(JSON.stringify(delivered)).not.toContain(tenant === t.a ? 'beta' : 'acme');
      expect(await countIn(tenant, 'schedule_alert_outbox', `run_id = $1 and state = 'delivered'`, [runId])).toBe(1);
    }
  });

  it('the retention sweeps trim runs and alerts in both tenants, and a batch of one in A deletes one of A’s', async () => {
    const old = new Date(t.h.clock.now.getTime() - 100 * DAY);
    const seeded = [];
    for (const tenant of [t.a, t.b]) {
      const scheduleId = await seedSchedule(tenant);
      const oldRun = newId();
      const freshRun = newId();
      await repo.insertRun(tenant.tdb, { id: oldRun, scheduleId, trigger: 'schedule', status: 'skipped', at: old });
      await repo.insertRun(tenant.tdb, {
        id: freshRun,
        scheduleId,
        trigger: 'schedule',
        status: 'skipped',
        at: t.h.clock.now,
      });
      const oldAlert = newId();
      await tenant.tdb.query(
        `insert into schedule_alert_outbox (id, schedule_id, target_index, kind, payload, state, created_at)
         values ($1, $2, 0, 'failure', '{}', 'delivered', $3)`,
        [oldAlert, scheduleId, old],
      );
      seeded.push({ tenant, oldRun, freshRun, oldAlert });
    }
    // The deletes name no tenant and limit in a sub-select: a batch of one in A's unit is one of A's.
    const cutoff = new Date(t.h.clock.now.getTime() - 90 * DAY);
    const extra = await seedSchedule(t.a);
    for (let i = 0; i < 2; i += 1) {
      await repo.insertRun(t.a.tdb, {
        id: newId(),
        scheduleId: extra,
        trigger: 'schedule',
        status: 'skipped',
        at: old,
      });
    }
    const oldRuns = (tenant: Tenant) => countIn(tenant, 'schedule_runs', 'queued_at < $1', [cutoff]);
    const [beforeA, beforeB] = [await oldRuns(t.a), await oldRuns(t.b)];
    expect(await t.a.tdb.transaction((tx) => repo.deleteRunsBefore(tx, cutoff, 1))).toBe(1);
    expect(await oldRuns(t.a)).toBe(beforeA - 1);
    expect(await oldRuns(t.b)).toBe(beforeB);
    const week = new Date(t.h.clock.now.getTime() - 7 * DAY);
    expect(await t.a.tdb.transaction((tx) => repo.deleteOutboxBefore(tx, week, 1))).toBe(1);
    expect(await countIn(t.b, 'schedule_alert_outbox', `state <> 'pending' and created_at < $1`, [week])).toBe(1);
    // The module's two sweepers, as it builds them.
    const sweep = (job: string, deleteBefore: typeof repo.deleteRunsBefore, maxAgeDays: number) =>
      new CaptureSweeper({
        target: { tenancy: t.h.ctx.tenancy, job, deleteBefore },
        maxAgeDays,
        now: () => t.h.clock.now,
        setTimer: timers.setTimer,
        log: quietLog(),
      }).runOnce();
    await sweep('schedule-run-retention', repo.deleteRunsBefore, 90);
    await sweep('schedule-alert-retention', repo.deleteOutboxBefore, 7);
    for (const { tenant, oldRun, freshRun, oldAlert } of seeded) {
      expect(await countIn(tenant, 'schedule_runs', 'id = $1', [oldRun])).toBe(0);
      expect(await countIn(tenant, 'schedule_runs', 'id = $1', [freshRun])).toBe(1);
      expect(await countIn(tenant, 'schedule_alert_outbox', 'id = $1', [oldAlert])).toBe(0);
    }
  });

  it('a tenant whose license lacks scheduled-runs fires nothing while the other does', async () => {
    expect((await t.b.call(cast(t.b).root, 'DELETE', '/license')).status).toBe(204);
    const inA = await seedSchedule(t.a, { due: true });
    const inB = await seedSchedule(t.b, { due: true });
    started.length = 0;
    const pass = await scheduler!.runOnce();
    expect(pass.fired).toBe(1);
    expect(await runsOf(t.a, inA)).toHaveLength(1);
    expect(await runsOf(t.b, inB)).toEqual([]);
    expect(started.map((run) => run.tenantId)).toEqual([t.a.scope.tenantId]);
    await scheduler!.idle();
  });
});
