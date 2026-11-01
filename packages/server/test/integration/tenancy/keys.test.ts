/**
 * The tenants' data keys over a real database (hosted edition spec §19.7, ADR-0036, plan Task 23): made with the
 * tenant when the root exists, made lazily by a compare-and-set when it appears later, bound to the tenant's row,
 * and cached until the row changes in this process.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { open, seal } from '../../../src/hooks/secret-box.js';
import { userSecretsKey } from '../../../src/host/server-platform.js';
import { TenantAdmin } from '../../../src/tenancy/directory.js';
import { environmentKeyRoot, newDataKey, TenantKeys, type KeyRoot } from '../../../src/tenancy/keys.js';
import type { TenantScope } from '../../../src/tenancy/scope.js';
import { createTenancy, directoryOf, type Tenancy } from '../../../src/tenancy/tenancy.js';
import { describeDb, testDatabase } from '../../helpers/database.js';

const ROOT = Buffer.alloc(32, 0x5a);
const ALICE = '01JB3Z9K7Q4ZJ6X1V8W2M5N0PA';
const BOB = '01JB3Z9K7Q4ZJ6X1V8W2M5N0PB';

describeDb('the tenant data keys (spec §19.7)', () => {
  let db: Awaited<ReturnType<typeof testDatabase>>;
  let slugs = 0;
  beforeAll(async () => {
    db = await testDatabase();
  });
  afterAll(async () => {
    await db.close();
  });

  /** A tenancy over the shared database, as one process would build it: with the root, or without. */
  async function processWith(root: Buffer | undefined): Promise<Tenancy> {
    const tenancy = createTenancy(db, root === undefined ? {} : { keyRoot: environmentKeyRoot(root) });
    await directoryOf(tenancy).load();
    return tenancy;
  }

  async function newTenant(tenancy: Tenancy): Promise<TenantScope> {
    slugs++;
    const slug = `keys-${slugs}-${Date.now().toString(36)}`;
    return (await new TenantAdmin(db, directoryOf(tenancy)).create({ slug, name: slug })).scope;
  }

  const wrappedOf = async (scope: TenantScope): Promise<Buffer | null> =>
    (await db.owner.query<{ k: Buffer | null }>('select data_key as k from tenants where id = $1', [scope.tenantId]))
      .rows[0]!.k;

  it('a tenant created with the root has its key at once, and another process opens the same one', async () => {
    const here = await processWith(ROOT);
    const scope = await newTenant(here);
    const wrapped = await wrappedOf(scope);
    expect(wrapped).not.toBeNull();
    const key = await here.dataKey(scope);
    expect(key).toHaveLength(32);
    expect(wrapped!.includes(key)).toBe(false);
    expect(await (await processWith(ROOT)).dataKey(scope)).toEqual(key);
  });

  it("a wrapped key opens for its tenant, and not when copied onto another tenant's row", async () => {
    const here = await processWith(ROOT);
    const a = await newTenant(here);
    const b = await newTenant(here);
    await db.owner.query('update tenants set data_key = (select data_key from tenants where id = $1) where id = $2', [
      a.tenantId,
      b.tenantId,
    ]);
    const fresh = await processWith(ROOT);
    expect(await fresh.dataKey(a)).toHaveLength(32);
    await expect(fresh.dataKey(b)).rejects.toMatchObject({ code: 'tenancy-data-key-refused' });
  });

  it("a blob of a user of A opens neither under B's key nor under another user's", async () => {
    const here = await processWith(ROOT);
    const a = await newTenant(here);
    const b = await newTenant(here);
    const keyA = await here.dataKey(a);
    const keyB = await here.dataKey(b);
    expect(keyA.equals(keyB)).toBe(false);
    const sealed = seal(userSecretsKey(keyA, ALICE), 'acme host secret');
    expect(open(userSecretsKey(keyA, ALICE), sealed)).toBe('acme host secret');
    expect(() => open(userSecretsKey(keyB, ALICE), sealed)).toThrow();
    expect(() => open(userSecretsKey(keyA, BOB), sealed)).toThrow();
    // Nor under slice 2's key, straight from the root.
    expect(() => open(userSecretsKey(ROOT, ALICE), sealed)).toThrow();
  });

  it('a tenant created without a root gets its key when the root appears', async () => {
    const without = await processWith(undefined);
    const scope = await newTenant(without);
    expect(await wrappedOf(scope)).toBeNull();
    await expect(without.dataKey(scope)).rejects.toMatchObject({ code: 'tenancy-no-root' });
    expect(await wrappedOf(scope)).toBeNull();
    const withRoot = await processWith(ROOT);
    const key = await withRoot.dataKey(scope);
    expect(await wrappedOf(scope)).not.toBeNull();
    expect(await (await processWith(ROOT)).dataKey(scope)).toEqual(key);
  });

  it('two concurrent lazy creations leave one key, and both callers use it', async () => {
    const scope = await newTenant(await processWith(undefined));
    const one = await processWith(ROOT);
    const two = await processWith(ROOT);
    const [first, second] = await Promise.all([one.dataKey(scope), two.dataKey(scope)]);
    expect(first).toEqual(second);
    expect(await (await processWith(ROOT)).dataKey(scope)).toEqual(first);
    // The loser kept the winner's key, not its own: the next read in either process is the same.
    expect(await one.dataKey(scope)).toEqual(first);
    expect(await two.dataKey(scope)).toEqual(first);
  });

  it('the cache drops a key when the row changes in this process, and only then', async () => {
    const here = await processWith(ROOT);
    const elsewhere = await processWith(ROOT);
    const scope = await newTenant(here);
    const before = await here.dataKey(scope);
    // The row replaced from another process (a rotation, say), which this one cannot see yet (slice 5).
    await db.owner.query('update tenants set data_key = null where id = $1', [scope.tenantId]);
    const after = await elsewhere.dataKey(scope);
    expect(after.equals(before)).toBe(false);
    expect(await here.dataKey(scope)).toEqual(before);
    // A write through this process's directory drops what it holds.
    directoryOf(here).changed();
    expect(await here.dataKey(scope)).toEqual(after);
  });

  it('invalidate() drops one tenant, or all', async () => {
    const creator = await processWith(ROOT);
    const elsewhere = await processWith(ROOT);
    const here = new TenantKeys(db, environmentKeyRoot(ROOT));
    const a = await newTenant(creator);
    const b = await newTenant(creator);
    const keyA = await here.dataKey(a.tenantId);
    const keyB = await here.dataKey(b.tenantId);
    await db.owner.query('update tenants set data_key = null where id = any($1::uuid[])', [[a.tenantId, b.tenantId]]);
    const newA = await elsewhere.dataKey(a);
    const newB = await elsewhere.dataKey(b);
    here.invalidate(a.tenantId);
    expect(await here.dataKey(a.tenantId)).toEqual(newA);
    expect(await here.dataKey(b.tenantId)).toEqual(keyB);
    here.invalidate();
    expect(await here.dataKey(b.tenantId)).toEqual(newB);
    expect(keyA.equals(newA)).toBe(false);
  });

  it('a tenant row that is gone is refused, and the refusal is not cached', async () => {
    const here = await processWith(ROOT);
    const scope = await newTenant(here);
    const row = (
      await db.owner.query<{ slug: string; name: string }>('select slug, name from tenants where id = $1', [
        scope.tenantId,
      ])
    ).rows[0]!;
    await db.owner.query('delete from tenants where id = $1', [scope.tenantId]);
    await expect(here.dataKey(scope)).rejects.toMatchObject({ code: 'tenancy-unknown-tenant' });
    // Restored: the next call reads again rather than answering the kept refusal.
    await db.owner.query('insert into tenants (id, slug, name) values ($1, $2, $3)', [
      scope.tenantId,
      row.slug,
      row.name,
    ]);
    expect(await here.dataKey(scope)).toHaveLength(32);
  });

  it('a key cached before its row is deleted is still served, until invalidated (spec §19.7, slice 5)', async () => {
    const here = await processWith(ROOT);
    const scope = await newTenant(here);
    const key = await here.dataKey(scope);
    await db.owner.query('delete from tenants where id = $1', [scope.tenantId]);
    expect(await here.dataKey(scope)).toEqual(key);
    directoryOf(here).changed();
    await expect(here.dataKey(scope)).rejects.toMatchObject({ code: 'tenancy-unknown-tenant' });
  });

  it("the loser of the compare-and-set uses the winner's key, and leaves the row as the winner wrote it", async () => {
    const creator = await processWith(undefined);
    const scope = await newTenant(creator);
    const real = environmentKeyRoot(ROOT);
    const winnerKey = Buffer.alloc(32, 0x77);
    let winnerWrap: Buffer | undefined;
    let made: Buffer | undefined;
    // Between this process's read (null) and its update, another process stores its own key.
    const racing: KeyRoot = {
      wrap: async (tenantId, dataKey) => {
        made = dataKey;
        winnerWrap = await real.wrap(tenantId, winnerKey);
        await db.owner.query('update tenants set data_key = $1 where id = $2', [winnerWrap, tenantId]);
        return real.wrap(tenantId, dataKey);
      },
      unwrap: (tenantId, wrapped) => real.unwrap(tenantId, wrapped),
    };
    const loser = new TenantKeys(db, racing);
    const got = await loser.dataKey(scope.tenantId);
    expect(made).toBeDefined();
    expect(got).toEqual(winnerKey);
    expect(got.equals(made!)).toBe(false);
    expect(await wrappedOf(scope)).toEqual(winnerWrap);
    // Every other process opens the same key.
    expect(await (await processWith(ROOT)).dataKey(scope)).toEqual(winnerKey);
  });

  it('a row cleared between the lost update and the re-read is a coded refusal, not a plain error', async () => {
    const creator = await processWith(undefined);
    const scope = await newTenant(creator);
    const real = environmentKeyRoot(ROOT);
    let updates = 0;
    // A competitor's write lands, then the row is cleared again before the loser re-reads it.
    const db2 = {
      query: async (text: string, values?: unknown[]) => {
        const result = await db.query(text, values);
        if (text.startsWith('update tenants')) {
          updates++;
          await db.owner.query('update tenants set data_key = null where id = $1', [scope.tenantId]);
        }
        return result;
      },
    };
    const racing: KeyRoot = {
      wrap: async (tenantId, dataKey) => {
        await db.owner.query('update tenants set data_key = $1 where id = $2', [
          await real.wrap(tenantId, newDataKey()),
          tenantId,
        ]);
        return real.wrap(tenantId, dataKey);
      },
      unwrap: (tenantId, wrapped) => real.unwrap(tenantId, wrapped),
    };
    const loser = new TenantKeys(db2 as unknown as typeof db, racing);
    await expect(loser.dataKey(scope.tenantId)).rejects.toMatchObject({ code: 'tenancy-data-key-missing' });
    expect(updates).toBe(1);
  });

  it('refuses a tenant id that is not a lower-case UUID before it reaches the key derivation', async () => {
    const here = await processWith(ROOT);
    const scope = await newTenant(here);
    const keys = new TenantKeys(db, environmentKeyRoot(ROOT));
    for (const id of [scope.tenantId.toUpperCase(), `{${scope.tenantId}}`, scope.tenantId.replaceAll('-', '')]) {
      await expect(keys.dataKey(id)).rejects.toMatchObject({ code: 'tenancy-tenant-id-invalid' });
      await expect(keys.wrapNew(id)).rejects.toMatchObject({ code: 'tenancy-tenant-id-invalid' });
    }
    // Nothing was stored for it under a derivation no canonical caller could open.
    expect(await keys.dataKey(scope.tenantId)).toEqual(await here.dataKey(scope));
  });
});
