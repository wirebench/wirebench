/**
 * The audit log with two tenants under the forced policy (tenancy Task 18; Task 14's listed cases). The chain,
 * anchor and queue SQL has no tenant filter of its own; `policy-filters.test.ts` (Task 17) runs each statement in
 * A's unit with B's rows present. This suite runs the module's paths end to end: events recorded by routes in both
 * tenants seal into two chains under each tenant's derived key, retention in one leaves the other's chain and
 * anchor alone, and B's list, export and desktop batch stay in B.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { keyId } from '../../../../src/audit-log/chain/canonical.js';
import { chainKeys, derivedChainKey } from '../../../../src/audit-log/chain/keys.js';
import { RetentionStopLog } from '../../../../src/audit-log/chain/retention-log.js';
import { AuditSealer } from '../../../../src/audit-log/chain/sealer.js';
import { verifyChain } from '../../../../src/audit-log/chain/verify.js';
import { auditLogModule } from '../../../../src/audit-log/module.js';
import { deleteSealedBefore, readAnchor } from '../../../../src/audit-log/repo.js';
import { CaptureSweeper } from '../../../../src/hooks/sweep.js';
import { runAdmin } from '../../../../src/identity/cli.js';
import { newId } from '../../../../src/identity/tokens.js';
import { licensingModule } from '../../../../src/licensing/module.js';
import { teamsModule } from '../../../../src/teams/module.js';
import * as teamsRepo from '../../../../src/teams/repo.js';
import { isDefaultTenant } from '../../../../src/tenancy/tenancy.js';
import { describeDb } from '../../../helpers/database.js';
import type { SignedInUser } from '../../../helpers/identity.js';
import { license, testKeys } from '../../../helpers/licensing.js';
import { quietLog } from '../../../helpers/schedule-runs.js';
import { manualTimers } from '../../../helpers/timers.js';
import { countIn, hosted, twoTenants, type Tenant, type TwoTenants } from './two-tenants.js';

const KEY = 'test-chain-key-0123456789abcdefghij';
const DAY = 86_400_000;
const keys = testKeys();

describeDb('the audit log in two tenants (tenancy Task 18)', () => {
  let t: TwoTenants;
  const timers = manualTimers();
  const workspaceId = newId();
  const roots: Partial<Record<'acme' | 'beta', SignedInUser>> = {};
  const root = (tenant: Tenant) => roots[tenant.slug]!;
  /** A sealer over the server's tenancy with the module's own key builder; the module's waits on manual timers. */
  let sealer: AuditSealer;
  let tenantKey: (tenant: Tenant) => string;
  beforeAll(async () => {
    t = await twoTenants({
      env: { WIREBENCH_SERVER_AUDIT_CHAIN_KEY: KEY, WIREBENCH_SERVER_AUDIT_MAX_AGE_DAYS: '365' },
      modules: (clock) => [
        licensingModule({ now: () => clock.now, publicKeys: [keys.publicKey] }),
        teamsModule({ now: () => clock.now }),
        auditLogModule({ now: () => clock.now, setTimer: timers.setTimer }),
      ],
    });
    const chain = chainKeys(KEY, t.h.ctx.config.mode, (scope) => isDefaultTenant(t.h.ctx.tenancy, scope));
    tenantKey = (tenant) => chain(tenant.scope);
    sealer = new AuditSealer({
      tenancy: t.h.ctx.tenancy,
      keys: chain,
      now: () => t.h.clock.now,
      setTimer: timers.setTimer,
      log: quietLog(),
    });
    for (const tenant of [t.a, t.b]) {
      roots[tenant.slug] = await tenant.user({ email: 'root@example.com', serverAdmin: true });
      const installed = await tenant.call(root(tenant), 'PUT', '/license', {
        license: license(keys, { edition: 'enterprise' }),
      });
      expect(installed.status).toBe(200);
      const team = await teamsRepo.insertTeam(tenant.tdb, { id: newId(), name: 'Ops', at: t.h.clock.now });
      await teamsRepo.insertMember(tenant.tdb, {
        teamId: team.id,
        userId: root(tenant).user.id,
        role: 'admin',
        at: t.h.clock.now,
      });
      await teamsRepo.insertWorkspace(tenant.tdb, {
        id: workspaceId,
        name: `Prod ${tenant.slug}`,
        teamId: team.id,
        defaultRole: 'viewer',
        createdBy: null,
        at: t.h.clock.now,
      });
    }
  });
  afterAll(() => t.close());

  /** Teams made through the route: each records `team.created` in the request's tenant. */
  const record = async (tenant: Tenant, count: number): Promise<string[]> => {
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const res = await tenant.call<{ id: string }>(root(tenant), 'POST', '/teams', { name: `Team ${newId()}` });
      expect(res.status).toBe(201);
      ids.push(res.body.id);
    }
    return ids;
  };
  const sealAll = async () => {
    for (let pass = 0; pass < 10; pass += 1) {
      if ((await sealer.runOnce()).sealed === 0) return;
    }
  };
  const unsealed = (tenant: Tenant) => countIn(tenant, 'audit_events', 'chain_seq is null');

  it("events in both tenants seal into two gapless chains, each verifying with its own key and failing with the other's", async () => {
    await record(t.a, 3);
    await record(t.b, 2);
    await sealAll();
    expect(await unsealed(t.a)).toBe(0);
    expect(await unsealed(t.b)).toBe(0);
    expect(tenantKey(t.a)).toBe(derivedChainKey(KEY, t.a.scope.tenantId));
    expect(tenantKey(t.a)).not.toBe(tenantKey(t.b));
    for (const [tenant, other] of [
      [t.a, t.b],
      [t.b, t.a],
    ] as const) {
      expect(await verifyChain(tenant.tdb, tenantKey(tenant))).toMatchObject({ kind: 'checked', result: 'intact' });
      expect(await verifyChain(tenant.tdb, tenantKey(other))).toEqual({
        kind: 'wrong-key',
        chainKeyId: keyId(tenantKey(tenant)),
      });
      // Gapless from 1: the tenant's own sequence, whatever the other sealed.
      const seqs = (
        await tenant.tdb.query<{ seq: string }>('select chain_seq::text as seq from audit_events order by chain_seq')
      ).rows.map((row) => Number(row.seq));
      expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1));
    }
  });

  it('admin audit verify --tenant checks only the chain of the tenant it names', async () => {
    await sealAll();
    for (const tenant of [t.a, t.b]) {
      // Counted first: the command records `audit.verified` after its walk.
      const sealed = await countIn(tenant, 'audit_events', 'chain_seq is not null');
      const out: string[] = [];
      const err: string[] = [];
      const code = await runAdmin(
        { command: 'admin-audit-verify', json: true, tenant: tenant.slug },
        {
          stdout: { write: (text: string) => out.push(text) },
          stderr: { write: (text: string) => err.push(text) },
          env: {
            WIREBENCH_SERVER_DATABASE_URL: t.h.db.url,
            WIREBENCH_SERVER_PUBLIC_URL: 'https://wirebench.test',
            WIREBENCH_SERVER_LOG_LEVEL: 'fatal',
            WIREBENCH_SERVER_AUDIT_CHAIN_KEY: KEY,
          },
        },
        { configure: hosted, publicKeys: [keys.publicKey], now: () => t.h.clock.now },
      );
      expect(code, err.join('')).toBe(0);
      expect(JSON.parse(out.join(''))).toMatchObject({
        checked: sealed,
        firstSeq: '1',
        unsealed: 0,
        result: 'intact',
      });
    }
  });

  it("B's audit list and export never show A's events", async () => {
    const inA = await record(t.a, 1);
    const list = await t.b.call<{ events: { target?: { id?: string } }[] }>(root(t.b), 'GET', '/audit?limit=200');
    expect(list.status).toBe(200);
    expect(list.body.events.length).toBeGreaterThan(0);
    expect(JSON.stringify(list.body)).not.toContain(inA[0]!);
    expect(JSON.stringify(list.body)).not.toContain(root(t.a).user.id);
    const exported = await t.b.inject({ method: 'GET', url: '/api/v1/audit/export', headers: root(t.b).headers });
    expect(exported.statusCode).toBe(200);
    expect(exported.body.length).toBeGreaterThan(0);
    expect(exported.body).not.toContain(inA[0]!);
    expect(exported.body).not.toContain(root(t.a).user.id);
    // A's own list has it.
    const own = await t.a.call(root(t.a), 'GET', '/audit?limit=200');
    expect(JSON.stringify(own.body)).toContain(inA[0]!);
  });

  it("B's desktop batch, under the workspace id both tenants have, lands in B only", async () => {
    const patched = await t.b.call(root(t.b), 'PATCH', `/workspaces/${workspaceId}`, { recordDesktopActivity: true });
    expect(patched.status).toBe(200);
    const sent = await t.b.call(root(t.b), 'POST', `/workspaces/${workspaceId}/audit/desktop-events`, {
      events: [
        {
          action: 'desktop.request_sent',
          details: {
            protocol: 'rest',
            method: 'GET',
            url: 'https://api.example.com/orders',
            status: 200,
            outcome: 'ok',
            durationMs: 42,
            environment: 'staging',
            requestId: 'req-1',
            requestName: 'List orders',
            sentAt: '2026-09-24T11:59:00.000Z',
          },
        },
      ],
    });
    expect(sent.status).toBe(204);
    const desktop = `action like 'desktop.%' and workspace_id = $1`;
    expect(await countIn(t.b, 'audit_events', desktop, [workspaceId])).toBe(1);
    expect(await countIn(t.a, 'audit_events', desktop, [workspaceId])).toBe(0);
    // A's workspace does not record: B's setting did not reach it.
    const inA = await t.a.call<{ code: string }>(root(t.a), 'POST', `/workspaces/${workspaceId}/audit/desktop-events`, {
      events: [],
      dropped: 1,
    });
    expect(inA.body.code).toBe('audit-desktop-recording-off');
  });

  it("retention in A's turn deletes A's old sealed rows and moves A's anchor only; B's rows and anchor are untouched", async () => {
    await sealAll();
    const anchorB = await readAnchor(t.b.tdb);
    const anchorA = await readAnchor(t.a.tdb);
    const rowsB = await countIn(t.b, 'audit_events');
    const rowsA = await countIn(t.a, 'audit_events');
    // Every row of both tenants is past the cutoff now; the sweep's job loop runs A's turn only, as a pass where B's
    // unit had nothing to do. The deletes have no tenant filter of their own (chain_seq is unique per tenant only).
    t.h.clock.advance(400 * DAY);
    const onlyA = {
      db: t.h.ctx.tenancy.db,
      forEachTenant: ((job, fn, log) =>
        t.h.ctx.tenancy.forEachTenant(
          job,
          async (tx, scope) => {
            if (scope.tenantId === t.a.scope.tenantId) await fn(tx, scope);
          },
          log,
        )) as typeof t.h.ctx.tenancy.forEachTenant,
    };
    const sweeper = new CaptureSweeper({
      maxAgeDays: 365,
      now: () => t.h.clock.now,
      setTimer: timers.setTimer,
      log: quietLog(),
      target: {
        tenancy: onlyA,
        job: 'audit-retention',
        // The module's keyed delete, with the module's own key for the unit's tenant.
        deleteBefore: (tx, cutoff, limit) =>
          deleteSealedBefore(
            tx,
            tenantKey(tx.scope.tenantId === t.a.scope.tenantId ? t.a : t.b),
            cutoff,
            limit,
            new RetentionStopLog(quietLog()),
          ),
      },
    });
    expect(await sweeper.runOnce()).toBe(rowsA);
    expect(await countIn(t.a, 'audit_events')).toBe(0);
    const movedA = await readAnchor(t.a.tdb);
    expect(movedA?.seq).toBeGreaterThan(anchorA?.seq ?? 0n);
    // B: every row, and the anchor byte for byte, still there; its chain verifies under its own key.
    expect(await countIn(t.b, 'audit_events')).toBe(rowsB);
    expect(await readAnchor(t.b.tdb)).toEqual(anchorB);
    expect(await verifyChain(t.b.tdb, tenantKey(t.b))).toMatchObject({ kind: 'checked', result: 'intact' });
    // A's new events chain on from its moved anchor.
    // (The root's token lapsed with the jump: a new admin of A's records it.)
    roots.acme = await t.a.user({ email: 'later@example.com', serverAdmin: true });
    await record(t.a, 1);
    await sealAll();
    expect(await verifyChain(t.a.tdb, tenantKey(t.a))).toMatchObject({ kind: 'checked', result: 'intact' });
  });
});
