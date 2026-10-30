/**
 * Licensing in a tenant, through its real call sites (tenancy Task 9 review I1, M1, M3, M5): the seat lock as
 * `assertSeatAvailable` takes it, the last-seat race in one tenant, `stateWithoutScope`'s three answers, and the
 * start-up message when `server_identity` has lost its row.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WirebenchError } from '@wirebench/engine';
import { createDatabase } from '../../../src/db/pool.js';
import * as identityRepo from '../../../src/identity/repo.js';
import { newId } from '../../../src/identity/tokens.js';
import { MISSING_SERVER_ID, serverId } from '../../../src/licensing/repo.js';
import { SEAT_LOCK_KEY, SEAT_LOCK_TENANT_KEY } from '../../../src/licensing/seats.js';
import { SEVERAL_TENANTS_MESSAGE, createLicenseService } from '../../../src/licensing/service.js';
import { TenantAdmin, TenantDirectory } from '../../../src/tenancy/directory.js';
import { directoryOf } from '../../../src/tenancy/tenancy.js';
import { describeDb, testDatabase } from '../../helpers/database.js';
import { signedInUser, type IdentityHarness } from '../../helpers/identity.js';
import { license, licensingHarness, testKeys, type TestKeys } from '../../helpers/licensing.js';
import { call } from '../../helpers/teams.js';

const OTHER_TENANT = '00000000-0000-4000-8000-0000000000b2';

describeDb('licensing in a tenant, through its call sites (Task 9 review)', () => {
  let keys: TestKeys;
  let h: IdentityHarness;
  beforeEach(async () => {
    keys = testKeys();
    h = await licensingHarness(keys);
  });
  afterEach(() => h.close());

  it('assertSeatAvailable holds the tenant’s two-key lock and the legacy one, and leaves another tenant’s free', async () => {
    const other = createDatabase(h.db.url, { max: 1 });
    // Asked from another connection while the seat check's unit is open: `false` while it is held.
    const free = (sql: string, params: readonly unknown[]) =>
      other.transaction(async (tx) => (await tx.query<{ got: boolean }>(sql, params)).rows[0]!.got);
    const tenantLock = `select pg_try_advisory_xact_lock(${String(SEAT_LOCK_KEY)}, ${SEAT_LOCK_TENANT_KEY}) as got`;
    const legacyLock = `select pg_try_advisory_xact_lock(${String(SEAT_LOCK_KEY)}) as got`;
    try {
      await h.tdb.transaction(async (tx) => {
        await h.ctx.license.assertSeatAvailable(tx);
        expect(await free(tenantLock, [h.tdb.scope.tenantId])).toBe(false);
        expect(await free(legacyLock, [])).toBe(false);
        expect(await free(tenantLock, [OTHER_TENANT])).toBe(true);
      });
      // Released with the unit.
      expect(await free(tenantLock, [h.tdb.scope.tenantId])).toBe(true);
    } finally {
      await other.close();
    }
  });

  it('gives the last seat to exactly one of two racing sign-ups in one tenant', async () => {
    const root = await signedInUser(h, { email: 'root@example.com', serverAdmin: true });
    const used = (await h.ctx.license.state(h.tdb.scope)).seats.used;
    expect((await call(h, root, 'PUT', '/license', { license: license(keys, { seats: used + 1 }) })).status).toBe(200);
    // Each holds its unit open past the other's check: without the lock both would count a free seat.
    const signUp = (email: string) =>
      h.tdb.transaction(async (tx) => {
        await h.ctx.license.assertSeatAvailable(tx);
        await new Promise((resolve) => setTimeout(resolve, 100));
        await identityRepo.insertUser(tx, {
          id: newId(),
          email,
          displayName: email,
          serverAdmin: false,
          at: h.clock.now,
        });
      });
    const outcomes = await Promise.allSettled([signUp('one@example.com'), signUp('two@example.com')]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const refused = outcomes.find((outcome) => outcome.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ code: 'licensing-seat-limit' });
  });

  it('stateWithoutScope: the one tenant’s state, Community with a reason (warned once) for several, a failure thrown', async () => {
    const warn = vi.fn();
    const service = createLicenseService({
      tenancy: h.ctx.tenancy,
      publicKeys: [keys.publicKey],
      now: () => h.clock.now,
      serverId: (db) => serverId(db),
      log: { warn },
    });
    const root = await signedInUser(h, { email: 'root@example.com', serverAdmin: true });
    await call(h, root, 'PUT', '/license', { license: license(keys, { edition: 'enterprise' }) });
    expect(await service.stateWithoutScope()).toEqual(await service.state(h.tdb.scope));
    expect((await service.stateWithoutScope()).edition).toBe('enterprise');

    await new TenantAdmin(h.db, directoryOf(h.ctx.tenancy)).create({ slug: 'second', name: 'Second' });
    for (let pass = 0; pass < 3; pass += 1) {
      expect(await service.stateWithoutScope()).toMatchObject({
        edition: 'community',
        features: [],
        message: SEVERAL_TENANTS_MESSAGE,
      });
    }
    expect(warn).toHaveBeenCalledTimes(1);

    const failing = createLicenseService({
      tenancy: h.ctx.tenancy,
      publicKeys: [keys.publicKey],
      now: () => h.clock.now,
      serverId: () => Promise.reject(new WirebenchError('test-boom', 'the server id could not be read')),
    });
    await expect(failing.stateWithoutScope()).rejects.toMatchObject({ code: 'test-boom' });
  });
});

describeDb('a server that lost its server_identity row (Task 9 review M5)', () => {
  it('refuses to start with the restore-from-a-backup advice, not as a missing tenant', async () => {
    const db = await testDatabase();
    try {
      await db.owner.query('delete from server_identity');
      await expect(new TenantDirectory(db).load()).rejects.toMatchObject({
        code: 'server-identity-missing',
        message: MISSING_SERVER_ID,
      });
    } finally {
      await db.close();
    }
  });
});
