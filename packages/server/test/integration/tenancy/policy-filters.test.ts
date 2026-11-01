/**
 * The statements whose only tenant filter is the policy (plan Task 17; the Task 13 and 14 reviews): the audit chain,
 * anchor, queue and retention statements, and the schedules claims, name no tenant. Each runs here in A's unit as
 * the app role, with B's rows present, and touches only A's. The keyless retention deletes come first: a cross-tenant
 * delete there would be irreversible. Task 18 adds the module-level two-tenant cases on top of these.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import { anchorMacValid } from '../../../src/audit-log/chain/canonical.js';
import { RetentionStopLog } from '../../../src/audit-log/chain/retention-log.js';
import { AuditSealer } from '../../../src/audit-log/chain/sealer.js';
import { verifyChain } from '../../../src/audit-log/chain/verify.js';
import { auditHook } from '../../../src/audit-log/hook.js';
import {
  chainHead,
  claimForwardBatch,
  claimUnsealed,
  deleteAuditEventsBefore,
  deleteForwarded,
  deleteSealedBefore,
  deleteUnsealedBefore,
  enqueueForward,
  insertGenesis,
  readAnchor,
  releaseForwardLease,
  setAnchorHead,
} from '../../../src/audit-log/repo.js';
import { permissiveLicense, type AuditInput } from '../../../src/context.js';
import { newId } from '../../../src/identity/tokens.js';
import { AlertOutbox, type DeliverAlert } from '../../../src/schedules/alerts/outbox.js';
import * as schedules from '../../../src/schedules/repo.js';
import * as teams from '../../../src/teams/repo.js';
import { TenantAdmin } from '../../../src/tenancy/directory.js';
import type { TenantScope } from '../../../src/tenancy/scope.js';
import type { TenantDb } from '../../../src/tenancy/tenant-db.js';
import { createTenancy, directoryOf, type Tenancy } from '../../../src/tenancy/tenancy.js';
import { describeDb, testDatabase } from '../../helpers/database.js';
import { manualTimers } from '../../helpers/timers.js';

const KEY = Buffer.alloc(32, 7).toString('base64');
const OLD = new Date('2020-01-01T00:00:00Z');
const CUTOFF = new Date('2021-01-01T00:00:00Z');
const NOW = new Date('2026-11-01T12:00:00Z');

const silentLog = (() => {
  const quiet = (): void => undefined;
  const logger = { level: 'silent', fatal: quiet, error: quiet, warn: quiet, info: quiet, debug: quiet, trace: quiet };
  return { ...logger, silent: quiet, child: () => logger } as unknown as FastifyBaseLogger;
})();

describeDb('statements filtered by the policy alone, in two tenants (hosted spec §19.4, plan Task 17)', () => {
  let db: Awaited<ReturnType<typeof testDatabase>>;
  let tenancy: Tenancy;
  let a: TenantScope;
  let b: TenantScope;
  let dbA: TenantDb;
  let dbB: TenantDb;
  const tenantOf = (scope: TenantScope) => (scope.tenantId === a.tenantId ? dbA : dbB);
  /** The same tenancy over a job loop that visits only `scope`: one unit of that tenant, B's rows still there. */
  const only = (scope: TenantScope): Pick<Tenancy, 'db' | 'forEachTenant'> => ({
    db: tenancy.db,
    forEachTenant: async (_job, fn) => {
      await tenancy.db(scope).transaction((tx) => fn(tx, scope));
      return { served: 1, failed: [] };
    },
  });

  beforeAll(async () => {
    db = await testDatabase();
    tenancy = createTenancy(db);
    const directory = directoryOf(tenancy);
    await directory.load();
    a = directory.defaultScope();
    b = (await new TenantAdmin(db, directory).create({ slug: 'beta', name: 'Beta' })).scope;
    dbA = tenancy.db(a);
    dbB = tenancy.db(b);
  });
  afterAll(() => db.close());

  describe('the audit log', () => {
    let at = OLD.getTime();
    const event = (n: number): AuditInput => ({
      actor: { kind: 'system' },
      action: 'team.created',
      target: { kind: 'team', id: `T${String(n)}` },
    });
    /** `count` events in `scope`, each a second after the last, from `start`; queued for forwarding. */
    const record = async (scope: TenantScope, count: number, start: Date) => {
      at = start.getTime();
      const hook = auditHook(() => new Date((at += 1000)), { forward: true });
      for (let n = 0; n < count; n++) await tenantOf(scope).transaction((tx) => hook(tx, event(n)));
    };
    const ids = async (scope: TenantScope, where = 'true') =>
      (
        await tenantOf(scope).query<{ id: string }>(`select id from audit_events where ${where} order by at, id`)
      ).rows.map((row) => row.id);
    const sealer = (scope: TenantScope) =>
      new AuditSealer({
        tenancy: only(scope),
        keys: () => KEY,
        now: () => NOW,
        setTimer: manualTimers().setTimer,
        log: silentLog,
      });

    beforeEach(async () => {
      for (const tdb of [dbA, dbB]) {
        await tdb.query('delete from audit_events');
        await tdb.query('delete from audit_chain_anchor');
      }
    });

    it('deleteAuditEventsBefore and deleteUnsealedBefore, keyless, delete only the unit tenant’s old rows', async () => {
      await record(a, 3, OLD);
      await record(b, 3, OLD);
      const bBefore = await ids(b);
      expect(await deleteUnsealedBefore(dbA, CUTOFF, 1)).toBe(1);
      expect(await deleteAuditEventsBefore(dbA, CUTOFF, 1000)).toBe(2);
      expect(await ids(a)).toEqual([]);
      expect(await ids(b)).toEqual(bBefore);
      expect(bBefore).toHaveLength(3);
    });

    it('claimUnsealed claims only the unit tenant’s rows, so B’s are never sealed into A’s chain', async () => {
      await record(a, 2, NOW);
      await record(b, 3, NOW);
      const claimed = await dbA.transaction((tx) => claimUnsealed(tx, 1000));
      expect(claimed.map((row) => row.id).sort()).toEqual((await ids(a)).sort());
      // Sealing A seals A's rows only, and B's chain starts at 1 of its own.
      expect((await sealer(a).runOnce()).sealed).toBe(2);
      expect(await ids(b, 'chain_seq is not null')).toEqual([]);
      expect((await sealer(b).runOnce()).sealed).toBe(3);
      expect((await chainHead(dbA))?.seq).toBe(2n);
      expect((await chainHead(dbB))?.seq).toBe(3n);
      expect(await verifyChain(dbA, KEY)).toMatchObject({ result: 'intact', checked: 2 });
      expect(await verifyChain(dbB, KEY)).toMatchObject({ result: 'intact', checked: 3 });
    });

    it('readAnchor, insertGenesis and setAnchorHead read, create and move only the unit tenant’s anchor', async () => {
      const genesisA = await dbA.transaction((tx) => insertGenesis(tx, KEY));
      expect(await readAnchor(dbB)).toBeUndefined();
      // B's genesis is B's own row, not a conflict with A's (one anchor per tenant).
      const genesisB = await dbB.transaction((tx) => insertGenesis(tx, KEY));
      expect(await readAnchor(dbA)).toEqual(genesisA);
      expect(await readAnchor(dbB)).toEqual(genesisB);
      await dbA.transaction((tx) => setAnchorHead(tx, KEY, genesisA, 41n));
      expect((await readAnchor(dbA))?.headSeq).toBe(41n);
      const anchorB = await readAnchor(dbB);
      expect(anchorB).toEqual(genesisB);
      expect(anchorMacValid(KEY, anchorB!)).toBe(true);
    });

    it('retention by chain_seq deletes only the unit tenant’s sealed rows and moves only its anchor', async () => {
      await record(a, 3, OLD);
      await record(b, 3, OLD);
      await sealer(a).runOnce();
      await sealer(b).runOnce();
      // The same seqs, 1 to 3, in both tenants: chain_seq is unique only per tenant.
      const anchorB = await readAnchor(dbB);
      const stops = new RetentionStopLog(silentLog);
      expect(await dbA.transaction((tx) => deleteSealedBefore(tx, KEY, CUTOFF, 1000, stops))).toBe(3);
      expect(await ids(a)).toEqual([]);
      expect(await ids(b)).toHaveLength(3);
      expect(await readAnchor(dbB)).toEqual(anchorB);
      expect(await verifyChain(dbB, KEY)).toMatchObject({ result: 'intact', checked: 3 });
    });

    it('the forward queue: enqueue, claim and delete touch only the unit tenant’s rows', async () => {
      await record(a, 2, NOW);
      await record(b, 2, NOW);
      // A second enqueue of one of B's events from A's unit names a row A cannot see: the composite key refuses it.
      const [ofB] = await ids(b);
      await expect(dbA.transaction((tx) => enqueueForward(tx, ofB!))).rejects.toMatchObject({ code: '23503' });
      // One lease id in both tenants, so only the policy tells their rows apart.
      const lease = { id: 'L-shared', ms: 60_000 };
      const claimed = await dbA.transaction((tx) => claimForwardBatch(tx, 100, lease));
      expect(claimed.map((event) => event.id).sort()).toEqual((await ids(a)).sort());
      const leasedOf = async (tdb: TenantDb) =>
        (await tdb.query<{ lease_id: string | null }>('select lease_id from audit_forward_queue')).rows.map(
          (row) => row.lease_id,
        );
      expect(await leasedOf(dbB)).toEqual([null, null]);
      const claimedB = await dbB.transaction((tx) => claimForwardBatch(tx, 100, lease));
      // Deleting B's ids under the shared lease from A's unit deletes nothing; A's own go.
      expect(
        await dbA.transaction((tx) =>
          deleteForwarded(
            tx,
            claimedB.map((event) => event.id),
            lease.id,
          ),
        ),
      ).toBe(0);
      expect(await leasedOf(dbB)).toEqual(['L-shared', 'L-shared']);
      expect(
        await dbA.transaction((tx) =>
          deleteForwarded(
            tx,
            claimed.map((event) => event.id),
            lease.id,
          ),
        ),
      ).toBe(2);
      expect(await leasedOf(dbA)).toEqual([]);
      expect(await leasedOf(dbB)).toHaveLength(2);
    });

    it('releaseForwardLease frees only the unit tenant’s rows under a lease id both tenants hold (M4)', async () => {
      await record(a, 1, NOW);
      await record(b, 1, NOW);
      const lease = { id: 'L-both', ms: 60_000 };
      await dbA.transaction((tx) => claimForwardBatch(tx, 100, lease));
      await dbB.transaction((tx) => claimForwardBatch(tx, 100, lease));
      await dbA.transaction((tx) => releaseForwardLease(tx, lease.id));
      const leaseOf = async (tdb: TenantDb) =>
        (await tdb.query<{ lease_id: string | null }>('select lease_id from audit_forward_queue')).rows;
      expect(await leaseOf(dbA)).toEqual([{ lease_id: null }]);
      expect(await leaseOf(dbB)).toEqual([{ lease_id: 'L-both' }]);
    });

    it('retention stops at the unit tenant’s leased row, and B’s lease neither stops nor frees A (M4)', async () => {
      await record(a, 3, OLD);
      await record(b, 3, OLD);
      await sealer(a).runOnce();
      await sealer(b).runOnce();
      // B's first event is leased, which retention in A must not see; A's second one is leased too.
      const [firstB] = await ids(b);
      const [, secondA] = await ids(a);
      await dbB.query(
        "update audit_forward_queue set lease_id = 'L-b', leased_until = now() + interval '1 minute' where event_id = $1",
        [firstB],
      );
      await dbA.query(
        "update audit_forward_queue set lease_id = 'L-a', leased_until = now() + interval '1 minute' where event_id = $1",
        [secondA],
      );
      const stops = new RetentionStopLog(silentLog);
      // Only A's first sealed row goes: the prefix ends before A's own leased row, whatever B holds.
      expect(await dbA.transaction((tx) => deleteSealedBefore(tx, KEY, CUTOFF, 1000, stops))).toBe(1);
      expect(await ids(a)).toHaveLength(2);
      expect(await ids(b)).toHaveLength(3);
      expect(await verifyChain(dbB, KEY)).toMatchObject({ result: 'intact', checked: 3 });
    });
  });

  describe('the schedules', () => {
    const seed = async (scope: TenantScope) => {
      const tdb = tenantOf(scope);
      const team = await teams.insertTeam(tdb, { id: newId(), name: `Team ${scope.slug}`, at: NOW });
      const workspaceId = newId();
      await teams.insertWorkspace(tdb, {
        id: workspaceId,
        name: 'Staging',
        teamId: team.id,
        defaultRole: 'viewer',
        createdBy: null,
        at: NOW,
      });
      const scheduleId = newId();
      await schedules.insertSchedule(tdb, {
        id: scheduleId,
        workspaceId,
        name: 'Hourly',
        cron: '0 * * * *',
        timeZone: 'UTC',
        target: { project: 'Billing' },
        options: { timeoutMinutes: 15, allowProtected: false, insecureTls: false, bail: false },
        alerts: { targets: [{ kind: 'email', to: ['ops@example.test'] }], muteAfter: 3 },
        enabled: true,
        nextRunAt: new Date(NOW.getTime() - 60_000),
        createdBy: null,
        at: NOW,
      });
      const runIds = [newId(), newId()];
      for (const id of runIds)
        await schedules.insertRun(tdb, { id, scheduleId, trigger: 'schedule', status: 'queued', at: NOW });
      await tdb.query(
        `insert into schedule_alert_outbox (id, schedule_id, run_id, target_index, kind, payload, next_at)
         values ($1, $2, $3, 0, 'failure', '{}'::jsonb, $4)`,
        [newId(), scheduleId, runIds[0], new Date(NOW.getTime() - 1000)],
      );
      return { scheduleId, runIds };
    };
    let seededA: Awaited<ReturnType<typeof seed>>;
    let seededB: Awaited<ReturnType<typeof seed>>;
    beforeAll(async () => {
      seededA = await seed(a);
      seededB = await seed(b);
    });

    it('claimDueSchedules locks only the unit tenant’s due schedules', async () => {
      const due = await dbA.transaction((tx) => schedules.claimDueSchedules(tx, NOW, 100));
      expect(due.map((row) => row.id)).toEqual([seededA.scheduleId]);
    });

    it('claimQueuedRuns claims only the unit tenant’s runs, one at a time', async () => {
      const first = await dbA.transaction((tx) => schedules.claimQueuedRuns(tx, 1, NOW));
      expect(first).toHaveLength(1);
      expect(seededA.runIds).toContain(first[0]);
      const rest = await dbA.transaction((tx) => schedules.claimQueuedRuns(tx, 100, NOW));
      expect([...first, ...rest].sort()).toEqual([...seededA.runIds].sort());
      const statusOf = async (tdb: TenantDb) =>
        (await tdb.query<{ status: string }>('select status from schedule_runs order by id')).rows.map((r) => r.status);
      expect(await statusOf(dbA)).toEqual(['running', 'running']);
      expect(await statusOf(dbB)).toEqual(['queued', 'queued']);
    });

    it('the alert outbox claims and delivers only the unit tenant’s rows, and leaves B’s untouched', async () => {
      const delivered: string[] = [];
      const deliver: DeliverAlert = (target) => {
        delivered.push(target.kind);
        return Promise.resolve();
      };
      const license = permissiveLicense();
      const outbox = new AlertOutbox({
        tenancy: only(a),
        now: () => NOW,
        setTimer: manualTimers().setTimer,
        log: silentLog,
        license: () => ({
          ...license,
          state: () =>
            Promise.resolve({
              edition: 'enterprise',
              status: 'active',
              seats: { used: 0, limit: null },
              features: ['scheduled-runs'],
            }),
        }),
        deliver,
      });
      const bBefore = (await dbB.query('select state, attempts, next_at from schedule_alert_outbox')).rows;
      expect(await outbox.runOnce()).toEqual({ delivered: 1, failed: 0 });
      expect(delivered).toHaveLength(1);
      expect((await dbA.query<{ state: string }>('select state from schedule_alert_outbox')).rows).toEqual([
        { state: 'delivered' },
      ]);
      expect((await dbB.query('select state, attempts, next_at from schedule_alert_outbox')).rows).toEqual(bBefore);
      void seededB;
    });
  });
});
