/**
 * The custom-domain repository (hosted edition spec §23.1, §23.3), as the app role in each tenant's own unit: a claim
 * per tenant, holding a name exactly once across tenants, and releasing only one's own.
 */
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import {
  claim,
  getClaim,
  hold,
  listAll,
  newToken,
  record,
  release,
  removeClaim,
  serverAdminEmails,
  setLive,
} from '../../../src/custom-domains/repo.js';
import { TenantAdmin } from '../../../src/tenancy/directory.js';
import { tenantDbFactory, type TenantDb } from '../../../src/tenancy/tenant-db.js';
import { createTenancy, directoryOf } from '../../../src/tenancy/tenancy.js';
import { describeDb, testDatabase, type TestDatabase } from '../../helpers/database.js';

const NOW = new Date('2026-11-04T10:00:00Z');
const NAME = 'app.customer.test';
const silent = { error: () => undefined };

describeDb('custom-domain repository (hosted spec §23.1, §23.3)', () => {
  let db: TestDatabase;
  let a: TenantDb;
  let b: TenantDb;
  const ids: string[] = [];

  /** The hosts table as the app role sees it, outside any tenant: it is unscoped. */
  const hosts = async () =>
    (
      await db.query<{ host: string; tenant_id: string; live: boolean }>(
        'select host, tenant_id, live from tenant_hosts order by host',
      )
    ).rows;

  beforeAll(async () => {
    db = await testDatabase();
    const admin = new TenantAdmin(db, directoryOf(createTenancy(db)));
    const factory = tenantDbFactory(db);
    const first = await admin.create({ slug: 'cd-repo-a', name: 'A' });
    const second = await admin.create({ slug: 'cd-repo-b', name: 'B' });
    ids.push(first.scope.tenantId, second.scope.tenantId);
    a = factory(first.scope);
    b = factory(second.scope);
  });
  afterEach(async () => {
    for (const t of [a, b]) await t.transaction((tx) => removeClaim(tx));
    await db.query('delete from tenant_hosts');
  });
  afterAll(async () => {
    await db?.close();
  });

  it('makes a 32-byte base64url token, a new one each time', () => {
    const token = newToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(newToken()).not.toBe(token);
  });

  it('claims a name pending, and reads it back in the same tenant only', async () => {
    const made = await a.transaction((tx) => claim(tx, { name: NAME, createdBy: 'U1', now: NOW }));
    expect(made).toMatchObject({
      name: NAME,
      state: 'pending',
      createdBy: 'U1',
      createdAt: NOW,
      checkedAt: null,
      lastResult: null,
    });
    expect(await a.transaction((tx) => getClaim(tx))).toEqual(made);
    expect(await b.transaction((tx) => getClaim(tx))).toBeUndefined();
  });

  it('refuses a second claim in one tenant (custom-domains-one-per-tenant), and lets another tenant claim the same name', async () => {
    await a.transaction((tx) => claim(tx, { name: NAME, createdBy: null, now: NOW }));
    await expect(
      a.transaction((tx) => claim(tx, { name: 'site.customer.test', createdBy: null, now: NOW })),
    ).rejects.toMatchObject({ code: 'custom-domains-one-per-tenant' });
    const other = await b.transaction((tx) => claim(tx, { name: NAME, createdBy: null, now: NOW }));
    expect(other.state).toBe('pending');
    expect(other.token).not.toBe((await a.transaction((tx) => getClaim(tx)))!.token);
  });

  it('holds a name for its tenant, and answers held-elsewhere to another, naming no one', async () => {
    expect(await a.transaction((tx) => hold(tx, NAME))).toBe('held');
    // Holding again is still held: the job may retry.
    expect(await a.transaction((tx) => hold(tx, NAME))).toBe('held');
    const refused = await b.transaction((tx) => hold(tx, NAME));
    expect(refused).toBe('held-elsewhere');
    expect(await hosts()).toEqual([{ host: NAME, tenant_id: ids[0], live: false }]);
  });

  it('holds a name exactly once when two tenants verify it at the same moment, on two connections', async () => {
    let opened!: () => void;
    const aInside = new Promise<void>((resolve) => (opened = resolve));
    // A holds inside its unit and keeps it open while B tries: B's insert waits on A's row, then finds it.
    const first = a.transaction(async (tx) => {
      const outcome = await hold(tx, 'site.customer.test');
      opened();
      await new Promise((resolve) => setTimeout(resolve, 300));
      return outcome;
    });
    await aInside;
    const second = b.transaction((tx) => hold(tx, 'site.customer.test'));
    expect(await Promise.all([first, second])).toEqual(['held', 'held-elsewhere']);
    // And racing from the start, many times over: exactly one wins each name.
    for (let round = 0; round < 10; round++) {
      const name = `race-${String(round)}.customer.test`;
      const outcomes = await Promise.all([a, b].map((t) => t.transaction((tx) => hold(tx, name))));
      expect(
        outcomes.filter((outcome) => outcome === 'held'),
        name,
      ).toHaveLength(1);
      expect(
        outcomes.filter((outcome) => outcome === 'held-elsewhere'),
        name,
      ).toHaveLength(1);
    }
    expect((await hosts()).filter((row) => row.host === 'site.customer.test')).toEqual([
      { host: 'site.customer.test', tenant_id: ids[0], live: false },
    ]);
  });

  it("releases only the tenant's own row, and marks only its own row live", async () => {
    await a.transaction((tx) => hold(tx, NAME));
    await b.transaction((tx) => release(tx, NAME));
    expect(await b.transaction((tx) => setLive(tx, NAME, true))).toBe(false);
    expect(await hosts()).toEqual([{ host: NAME, tenant_id: ids[0], live: false }]);
    expect(await a.transaction((tx) => setLive(tx, NAME, true))).toBe(true);
    expect(await hosts()).toEqual([{ host: NAME, tenant_id: ids[0], live: true }]);
    await a.transaction((tx) => release(tx, NAME));
    expect(await hosts()).toEqual([]);
  });

  it('removes a claim by releasing its name first, and leaves a name another tenant holds', async () => {
    await a.transaction(async (tx) => {
      await claim(tx, { name: NAME, createdBy: null, now: NOW });
      await hold(tx, NAME);
    });
    await b.transaction((tx) => claim(tx, { name: 'site.customer.test', createdBy: null, now: NOW }));
    await b.transaction((tx) => hold(tx, 'site.customer.test'));
    const removed = await a.transaction((tx) => removeClaim(tx));
    expect(removed?.name).toBe(NAME);
    expect(await a.transaction((tx) => getClaim(tx))).toBeUndefined();
    expect(await hosts()).toEqual([{ host: 'site.customer.test', tenant_id: ids[1], live: false }]);
    expect(await a.transaction((tx) => removeClaim(tx))).toBeUndefined();
    // B claimed the name A held, unverified: A's removal leaves B's claim and B's own row alone.
    await b.transaction((tx) => removeClaim(tx));
    await b.transaction((tx) => claim(tx, { name: NAME, createdBy: null, now: NOW }));
    await a.transaction(async (tx) => {
      await claim(tx, { name: NAME, createdBy: null, now: NOW });
    });
    await b.transaction((tx) => hold(tx, NAME));
    await a.transaction((tx) => removeClaim(tx));
    expect(await hosts()).toEqual([{ host: NAME, tenant_id: ids[1], live: false }]);
  });

  it('records a check against the claim with that token only, never the token in the result', async () => {
    const made = await a.transaction((tx) => claim(tx, { name: NAME, createdBy: null, now: NOW }));
    const later = new Date(NOW.getTime() + 60_000);
    const lastResult = { cname: 'ok', txt: 'ok', message: 'Both in place.' } as const;
    expect(
      await a.transaction((tx) =>
        record(tx, made.token, {
          state: 'verified',
          lastResult,
          checkedAt: later,
          failingSince: null,
          verifiedAt: later,
        }),
      ),
    ).toBe(true);
    expect(await a.transaction((tx) => getClaim(tx))).toMatchObject({
      state: 'verified',
      lastResult,
      checkedAt: later,
      verifiedAt: later,
      activeAt: null,
      failingSince: null,
    });
    // A stale check, for a claim since removed and made again, writes nothing.
    expect(
      await a.transaction((tx) =>
        record(tx, 'another-token', { state: 'lapsed', lastResult, checkedAt: later, failingSince: null }),
      ),
    ).toBe(false);
    // Kept unless given; failing_since written as given.
    const third = new Date(NOW.getTime() + 120_000);
    await a.transaction((tx) =>
      record(tx, made.token, { state: 'failing', lastResult, checkedAt: third, failingSince: third }),
    );
    expect(await a.transaction((tx) => getClaim(tx))).toMatchObject({
      state: 'failing',
      verifiedAt: later,
      failingSince: third,
    });
  });

  it("lists each tenant's enabled server admins only", async () => {
    await a.query(
      `insert into users (id, email, email_lower, display_name, server_admin, created_at) values
        ('cd-u1', 'Admin@a.test', 'admin@a.test', 'Admin', true, now()),
        ('cd-u2', 'member@a.test', 'member@a.test', 'Member', false, now()),
        ('cd-u3', 'gone@a.test', 'gone@a.test', 'Gone', true, now())`,
    );
    await a.query("update users set disabled_at = now() where id = 'cd-u3'");
    expect(await a.transaction((tx) => serverAdminEmails(tx))).toEqual(['Admin@a.test']);
    expect(await b.transaction((tx) => serverAdminEmails(tx))).toEqual([]);
  });

  it("lists every tenant's claim for the operator, with its slug, never its token", async () => {
    await a.transaction((tx) => claim(tx, { name: NAME, createdBy: null, now: NOW }));
    await b.transaction((tx) => claim(tx, { name: 'site.customer.test', createdBy: null, now: NOW }));
    const listing = await listAll(createTenancy(db), silent);
    expect(
      listing.filter((row) => row.slug.startsWith('cd-repo-')).sort((x, y) => x.slug.localeCompare(y.slug)),
    ).toEqual([
      { slug: 'cd-repo-a', name: NAME, state: 'pending', checkedAt: null },
      { slug: 'cd-repo-b', name: 'site.customer.test', state: 'pending', checkedAt: null },
    ]);
    expect(JSON.stringify(listing)).not.toMatch(/token/);
  });
});
