/**
 * What a tenant unit costs on the hot paths (plan Task 17 perf; spec §19.8 guard 2). Each unit is a pool checkout
 * and three round trips beyond its statements (`begin`, `set_config`, `commit`), so the budgets are in units and
 * statements, which do not depend on the machine, plus one loose time budget:
 * - the authenticated-request guard (`callerForToken`: the lookup, the touch and the lazy delete in one unit),
 *   which every authenticated request pays (Task 8 review M3);
 * - a typical route, `GET /workspaces/:id`, in statements and time;
 * - the groupings the Task 9 review (M6) left open, measured as they stand: a role guard then a feature check,
 *   `PATCH /workspaces/:id` and `POST /teams/:id/members`. They are pinned here, so a change that adds a unit
 *   shows; the share socket's `featureOn` and `canView` (two units per join) are not measured here;
 * - the scheduler's starts with many licensed tenants and nothing queued (Task 13 review M2): no claim unit.
 *
 * Runs with a database, and skips with `WIREBENCH_SKIP_PERF=1` as every perf suite does.
 */
import type { FastifyBaseLogger } from 'fastify';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { permissiveLicense, type LicenseService } from '../../src/context.js';
import { identitySettings } from '../../src/identity/env.js';
import { callerForToken } from '../../src/identity/guard.js';
import { Scheduler } from '../../src/schedules/scheduler.js';
import { TenantAdmin } from '../../src/tenancy/directory.js';
import type { StatementLogEntry } from '../../src/tenancy/tenant-db.js';
import { directoryOf } from '../../src/tenancy/tenancy.js';
import { describeDb } from '../helpers/database.js';
import { signedInUser, type SignedInUser } from '../helpers/identity.js';
import { executorEnv } from '../helpers/schedule-runs.js';
import { schedulesHarness, type SchedulesCast } from '../helpers/schedules.js';
import { call } from '../helpers/teams.js';

const SKIP = process.env.WIREBENCH_SKIP_PERF === '1';
/** Straight to stderr, so the figures show in the run's output whatever the reporter keeps of the console. */
const say = (line: string): void => {
  process.stderr.write(`${line}\n`);
};
/** Tenants beside the default one, for the scheduler's idle starts. */
const IDLE_TENANTS = 50;

interface Cost {
  readonly units: number;
  readonly statements: number;
  /** Statements plus `begin`, `set_config` and `commit` per unit. */
  readonly roundTrips: number;
}

const costOf = (entries: readonly StatementLogEntry[]): Cost => {
  const units = new Set(entries.map((entry) => entry.unit)).size;
  const statements = entries.filter((entry) => entry.kind === 'statement').length;
  return { units, statements, roundTrips: statements + 3 * units };
};

describeDb('tenant units on the hot paths (plan Task 17 perf)', () => {
  let c: SchedulesCast;
  let workspacePath: string;
  let teamId: string;

  /** What `fn` sent through the tenant database, as a cost. */
  const measure = async (fn: () => Promise<unknown>): Promise<Cost> => {
    const from = c.h.statements.entries.length;
    await fn();
    return costOf(c.h.statements.entries.slice(from));
  };
  const ok = async (expected: number, made: Promise<{ readonly status: number }>) => {
    expect((await made).status).toBe(expected);
  };
  const report = (what: string, cost: Cost) => {
    say(
      `[perf] tenancy units: ${what}: ${String(cost.units)} units, ${String(cost.statements)} statements, ${String(cost.roundTrips)} round trips`,
    );
  };

  beforeAll(async () => {
    if (SKIP) return;
    c = await schedulesHarness();
    workspacePath = `/workspaces/${c.workspaceId}`;
    teamId = (await call<{ teamId: string }>(c.h, c.admin, 'GET', workspacePath)).body.teamId;
  });
  afterAll(async () => {
    if (!SKIP) await c.close();
  });

  it.skipIf(SKIP)('the guard: one unit, at most three statements, on every authenticated request', async () => {
    const env = {
      db: c.h.ctx.tenancy.db(c.h.tdb.scope),
      settings: identitySettings(c.h.ctx.config),
      now: () => c.h.clock.now,
    };
    // A token last used over a minute ago is touched; within the minute it is only looked up.
    const fresh: SignedInUser = await signedInUser(c.h, { email: 'guard@example.com' });
    c.h.clock.advance(61_000);
    const first = await measure(() => callerForToken(env, fresh.token));
    const again = await measure(() => callerForToken(env, fresh.token));
    report('guard, first use', first);
    report('guard, again', again);
    expect(first).toEqual({ units: 1, statements: 2, roundTrips: 5 });
    expect(again).toEqual({ units: 1, statements: 1, roundTrips: 4 });
  });

  it.skipIf(SKIP)('a typical route: GET /workspaces/:id, within its statement and time budget', async () => {
    await call(c.h, c.viewer, 'GET', workspacePath); // the token's touch, which the budget leaves out
    const cost = await measure(() => ok(200, call(c.h, c.viewer, 'GET', workspacePath)));
    report('GET /workspaces/:id', cost);
    // The guard's unit, the role guard's, and the read.
    expect(cost).toEqual({ units: 3, statements: 3, roundTrips: 12 });
    const times: number[] = [];
    for (let i = 0; i < 30; i++) {
      const started = performance.now();
      await ok(200, call(c.h, c.viewer, 'GET', workspacePath));
      times.push(performance.now() - started);
    }
    const median = times.sort((a, b) => a - b)[Math.floor(times.length / 2)]!;
    say(`[perf] tenancy units: GET /workspaces/:id median ${median.toFixed(1)} ms over 30`);
    // Loose: a local PostgreSQL answers in a few milliseconds; a CI runner is slower, never this slow.
    expect(median).toBeLessThan(100);
  });

  it.skipIf(SKIP)('the Task 9 groupings, as they stand (M6)', async () => {
    await call(c.h, c.admin, 'GET', workspacePath);
    const gated = await measure(() => ok(200, call(c.h, c.viewer, 'GET', `${workspacePath}/schedules`)));
    const patched = await measure(() => ok(200, call(c.h, c.admin, 'PATCH', workspacePath, { name: 'Renamed' })));
    const newcomer = await signedInUser(c.h, { email: 'newcomer@example.com' });
    const added = await measure(() =>
      ok(201, call(c.h, c.admin, 'POST', `/teams/${teamId}/members`, { email: newcomer.user.email, role: 'member' })),
    );
    report('role guard + feature check (GET /workspaces/:id/schedules)', gated);
    report('PATCH /workspaces/:id', patched);
    report('POST /teams/:id/members', added);
    // Pinned at what they measure: a change that adds a unit to one of them fails here.
    expect(gated).toEqual({ units: 4, statements: 4, roundTrips: 16 });
    expect(patched.units).toBeLessThanOrEqual(4);
    expect(added.units).toBeLessThanOrEqual(5);
  });

  it.skipIf(SKIP)('the scheduler claims in no tenant with nothing queued, however many are licensed', async () => {
    const directory = directoryOf(c.h.ctx.tenancy);
    const admin = new TenantAdmin(c.h.db, directory);
    for (let i = 0; i < IDLE_TENANTS; i++) await admin.create({ slug: `idle-${String(i)}`, name: `Idle ${String(i)}` });
    const licensed: LicenseService = {
      ...permissiveLicense(),
      state: () =>
        Promise.resolve({
          edition: 'enterprise',
          status: 'active',
          seats: { used: 0, limit: null },
          features: ['scheduled-runs'],
        }),
    };
    const scheduler = new Scheduler({
      ...executorEnv(c, null, '/nonexistent'),
      tenancy: c.h.ctx.tenancy,
      license: () => licensed,
      log: { error: () => undefined, warn: () => undefined, info: () => undefined } as unknown as FastifyBaseLogger,
    });
    const from = c.h.statements.entries.length;
    const started = performance.now();
    expect(await scheduler.runOnce()).toEqual({ fired: 0, started: 0 });
    const ms = performance.now() - started;
    const entries = c.h.statements.entries.slice(from);
    const claims = entries.filter((entry) => /update schedule_runs r set status = 'running'/.test(entry.text));
    const cost = costOf(entries);
    report(`a scheduler pass over ${String(IDLE_TENANTS + 1)} licensed tenants, nothing queued`, cost);
    say(`[perf] tenancy units: that pass took ${ms.toFixed(0)} ms`);
    expect(claims).toEqual([]);
    // The pass's own unit per tenant, and no other.
    expect(cost.units).toBe(IDLE_TENANTS + 1);
    await scheduler.stop();
  });
});
