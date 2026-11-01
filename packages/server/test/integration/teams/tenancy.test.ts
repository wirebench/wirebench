/**
 * Teams-access and licensing in a tenant (tenancy plan Task 9; spec §19.8, §19.13). Until `0021` there is one
 * tenant, so the suite shows that every statement the two modules send goes through the tenant database: the
 * modules have no `ctx.db`, and the statement log shows each one after its unit's `set_config`. The seat lock is keyed by schema and tenant.
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { AccessChangedEvent } from '../../../src/context.js';
import { SEAT_LOCK_KEY, SEAT_LOCK_TENANT_KEY } from '../../../src/licensing/seats.js';
import { createDatabase } from '../../../src/db/pool.js';
import { newId } from '../../../src/identity/tokens.js';
import { describeDb, testDatabase } from '../../helpers/database.js';
import { signedInUser, type IdentityHarness, type SignedInUser } from '../../helpers/identity.js';
import { license, licensingHarness, testKeys, type TestKeys } from '../../helpers/licensing.js';
import { call } from '../../helpers/teams.js';
import { expectAllScoped } from '../../helpers/tenancy.js';

describeDb('teams-access and licensing in a tenant (tenancy Task 9)', () => {
  let keys: TestKeys;
  let h: IdentityHarness;
  let root: SignedInUser;
  let ana: SignedInUser;
  beforeEach(async () => {
    keys = testKeys();
    h = await licensingHarness(keys);
    root = await signedInUser(h, { email: 'root@example.com', serverAdmin: true });
    ana = await signedInUser(h, { email: 'ana@example.com' });
  });
  afterEach(() => h.close());

  it('runs every statement of every route it serves inside a unit of the request’s tenant', async () => {
    const accessed: AccessChangedEvent[] = [];
    h.hooks.accessChanged.push((event) => {
      accessed.push(event);
    });
    h.statements.entries.length = 0;
    const ok = async (status: number, request: Promise<{ readonly status: number; readonly body: unknown }>) => {
      const res = await request;
      expect(res.status, JSON.stringify(res.body)).toBe(status);
      return res.body;
    };

    // The license, installed, read and removed.
    await ok(200, call(h, root, 'PUT', '/license', { license: license(keys) }));
    await ok(200, call(h, root, 'GET', '/license'));
    await ok(200, call(h, undefined, 'GET', '/meta'));

    // A team, its members and its invitations.
    const team = (await ok(201, call(h, root, 'POST', '/teams', { name: 'Payments QA' }))) as { id: string };
    await ok(200, call(h, root, 'GET', '/teams'));
    await ok(200, call(h, root, 'PATCH', `/teams/${team.id}`, { name: 'Payments' }));
    await ok(201, call(h, root, 'POST', `/teams/${team.id}/members`, { email: 'ana@example.com', role: 'member' }));
    await ok(200, call(h, root, 'GET', `/teams/${team.id}/members`));
    await ok(200, call(h, root, 'PATCH', `/teams/${team.id}/members/${ana.user.id}`, { role: 'admin' }));
    const invited = (await ok(
      201,
      call(h, root, 'POST', `/teams/${team.id}/invitations`, { email: 'bea@example.com', role: 'member' }),
    )) as { id: string };
    await ok(200, call(h, root, 'GET', `/teams/${team.id}/invitations`));
    await ok(204, call(h, root, 'DELETE', `/teams/${team.id}/invitations/${invited.id}`));

    // A workspace with an id the app chose, its grants, and its end.
    const id = newId();
    await ok(201, call(h, ana, 'POST', `/teams/${team.id}/workspaces`, { id, name: 'Staging' }));
    // A second create with the same id, in the same tenant, is the same conflict as before (workspaces_pkey).
    expect(await call(h, ana, 'POST', `/teams/${team.id}/workspaces`, { id, name: 'Other' })).toMatchObject({
      status: 409,
      body: { code: 'teams-workspace-exists' },
    });
    await ok(200, call(h, ana, 'GET', '/workspaces'));
    await ok(200, call(h, ana, 'GET', `/workspaces/${id}`));
    await ok(200, call(h, ana, 'PATCH', `/workspaces/${id}`, { defaultRole: 'editor' }));
    await ok(200, call(h, ana, 'GET', `/workspaces/${id}/access`));
    await ok(204, call(h, ana, 'DELETE', `/teams/${team.id}/members/${ana.user.id}`));
    await ok(204, call(h, root, 'DELETE', `/workspaces/${id}`));
    await ok(204, call(h, root, 'DELETE', `/teams/${team.id}`));
    await ok(204, call(h, root, 'DELETE', '/license'));

    expectAllScoped(h.statements, h.tdb.scope.tenantId);
    // Every access announcement carries the tenant (spec §19.8 guard 5).
    expect(accessed.length).toBeGreaterThan(0);
    for (const event of accessed) {
      expect(event.tenantId).toBe(h.tdb.scope.tenantId);
      expect(event.tenant).toBe(h.tdb.scope);
    }
  });

  it('reads the team guard’s facts, the team and the caller’s role, in one unit', async () => {
    const team = (await call<{ id: string }>(h, root, 'POST', '/teams', { name: 'Platform' })).body;
    await call(h, root, 'POST', `/teams/${team.id}/members`, { email: 'ana@example.com', role: 'member' });
    h.statements.entries.length = 0;
    expect((await call(h, ana, 'GET', `/teams/${team.id}/members`)).status).toBe(200);
    const statements = h.statements.entries.filter((entry) => entry.kind === 'statement');
    const teamRead = statements.find((entry) => /from teams\b/.test(entry.text));
    expect(teamRead).toBeDefined();
    const guardUnit = statements.filter((entry) => entry.unit === teamRead!.unit);
    expect(guardUnit).toHaveLength(2);
    expect(guardUnit[1]!.text).toMatch(/team_members/);
  });
});

describeDb('the seat lock (spec §19.8 guard 5)', () => {
  const ONE = '00000000-0000-4000-8000-000000000001';
  const TWO = '00000000-0000-4000-8000-000000000002';
  const keyOf = async (db: { query: IdentityHarness['db']['query'] }, tenantId: string): Promise<number> =>
    (await db.query<{ key: number }>(`select ${SEAT_LOCK_TENANT_KEY} as key`, [tenantId])).rows[0]!.key;

  it('keys on the schema and the tenant: two tenants, or two schemas, never share one', async () => {
    // Migrated, so the app role may use the schema: `current_schema()` is null on one it cannot.
    const first = await testDatabase();
    const second = await testDatabase();
    try {
      const keys = [await keyOf(first, ONE), await keyOf(first, TWO), await keyOf(second, ONE)];
      expect(new Set(keys).size).toBe(3);
      expect(await keyOf(first, ONE)).toBe(keys[0]);
    } finally {
      await first.close();
      await second.close();
    }
  });

  it("one tenant's seat check holds its own lock, never another tenant's", async () => {
    const db = await testDatabase();
    const other = createDatabase(db.url, { max: 1 });
    try {
      const lock = `select pg_try_advisory_xact_lock(${String(SEAT_LOCK_KEY)}, ${SEAT_LOCK_TENANT_KEY}) as got`;
      await db.transaction(async (tx) => {
        await tx.query(`select pg_advisory_xact_lock(${String(SEAT_LOCK_KEY)}, ${SEAT_LOCK_TENANT_KEY})`, [ONE]);
        const tryIn = (tenantId: string) =>
          other.transaction(async (t) => (await t.query<{ got: boolean }>(lock, [tenantId])).rows[0]!.got);
        expect(await tryIn(TWO)).toBe(true);
        expect(await tryIn(ONE)).toBe(false);
      });
    } finally {
      await other.close();
      await db.close();
    }
  });
});
