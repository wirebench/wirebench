/**
 * User profile Task 2 (spec §6.1): migration `0026`. `users` gains the username, its lower-case twin and the about
 * text; `user_images` is a tenant table under the one `tenant_isolation` policy, and goes with its user.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BUILTIN_MODULES } from '../../../src/modules.js';
import { allMigrations } from '../../../src/serve.js';
import { TenantAdmin } from '../../../src/tenancy/directory.js';
import { tenantDbFactory, type TenantDb } from '../../../src/tenancy/tenant-db.js';
import { createTenancy, directoryOf } from '../../../src/tenancy/tenancy.js';
import {
  columnsOf,
  keysOf,
  policiesOf,
  POLICY_EXPRESSION,
  rowSecurityOf,
  SCOPED_TABLES,
  SETTING_EXPRESSION,
} from '../../helpers/catalog.js';
import { describeDb, testDatabase, type TestDatabase } from '../../helpers/database.js';
import { defaultTenantDb } from '../../helpers/tenancy.js';

const outcome = (run: Promise<unknown>): Promise<string> =>
  run.then(
    () => 'ok',
    (error: unknown) => {
      const code = (error as { code?: unknown }).code;
      return typeof code === 'string' ? code : (error as Error).message;
    },
  );

const addUser = (tdb: TenantDb, id: string) =>
  tdb.query("insert into users (id, email, email_lower, display_name) values ($1, $2, $2, 'Someone')", [
    id,
    `${id}@example.test`,
  ]);
const setUsername = (tdb: TenantDb, id: string, username: string | null) =>
  tdb.query('update users set username = $2, username_lower = lower($2) where id = $1', [id, username]);
const addPhoto = (tdb: TenantDb, id: string) =>
  tdb.query(
    "insert into user_images (user_id, kind, content_type, data, sha256) values ($1, 'photo', 'image/webp', '\\x00', 'sha')",
    [id],
  );

describeDb('migration 0026: the user profile (user profile spec §6.1)', () => {
  let db: TestDatabase;
  let tdb: TenantDb;

  beforeAll(async () => {
    db = await testDatabase();
    tdb = await defaultTenantDb(db);
  });
  afterAll(async () => {
    await db?.close();
  });

  it('is migration 26, from the identity folder, after the control plane’s 0025', async () => {
    const migrations = await allMigrations(BUILTIN_MODULES);
    expect(migrations.slice(-2).map((m) => `${m.version}_${m.name}`)).toEqual(['25_signup-ref', '26_user-profile']);
  });

  describe('users', () => {
    it('gains username, username_lower and about, the about text empty by default', async () => {
      const columns = (await columnsOf(db.owner)).filter((column) => column.table === 'users').slice(-3);
      expect(columns.map(({ column, type, notNull, default: fallback }) => [column, type, notNull, fallback])).toEqual([
        ['username', 'text', false, null],
        ['username_lower', 'text', false, null],
        ['about', 'text', true, "''::text"],
      ]);
    });

    it('keys usernames per tenant under users_username_lower_key, and lets any number of people have none', async () => {
      const key = (await keysOf(db.owner)).find((k) => k.name === 'users_username_lower_key');
      expect(key).toMatchObject({ table: 'users', kind: 'u', columns: ['tenant_id', 'username_lower'] });
      await addUser(tdb, 'u-0026-a');
      await addUser(tdb, 'u-0026-b');
      await addUser(tdb, 'u-0026-c');
      await setUsername(tdb, 'u-0026-a', 'Ada');
      const taken = await setUsername(tdb, 'u-0026-b', 'ada').catch((error: unknown) => error);
      expect(taken).toMatchObject({ code: '23505', constraint: 'users_username_lower_key' });
      // Freed, the name is anyone's at once.
      await setUsername(tdb, 'u-0026-a', null);
      expect(await outcome(setUsername(tdb, 'u-0026-b', 'ada'))).toBe('ok');
    });

    it('lets two tenants share a username', async () => {
      const created = await new TenantAdmin(db, directoryOf(createTenancy(db))).create({
        slug: 'profile-0026',
        name: 'profile-0026',
      });
      const other = tenantDbFactory(db)(created.scope);
      try {
        await addUser(other, 'u-0026-other');
        expect(await outcome(setUsername(other, 'u-0026-other', 'ada'))).toBe('ok');
      } finally {
        await other.query('delete from users');
        await db.owner.query('delete from tenants where id = $1', [created.scope.tenantId]);
      }
    });

    it('refuses a username_lower that is not lower(username), either one missing included', async () => {
      for (const [username, lower] of [
        ['Ada', 'Ada'],
        ['Ada', null],
        [null, 'ada'],
      ] as const) {
        expect(
          await outcome(
            tdb.query('update users set username = $2, username_lower = $3 where id = $1', [
              'u-0026-c',
              username,
              lower,
            ]),
          ),
          `${String(username)}/${String(lower)}`,
        ).toBe('23514');
      }
    });
  });

  describe('user_images, a tenant table', () => {
    it('has its columns, tenant_id first with the setting default', async () => {
      const columns = (await columnsOf(db.owner)).filter((column) => column.table === 'user_images');
      expect(columns[0]).toMatchObject({
        column: 'tenant_id',
        type: 'uuid',
        notNull: true,
        default: SETTING_EXPRESSION,
      });
      expect(columns.map((c) => [c.column, c.type, c.notNull])).toEqual([
        ['tenant_id', 'uuid', true],
        ['user_id', 'text', true],
        ['kind', 'text', true],
        ['content_type', 'text', true],
        ['data', 'bytea', true],
        ['sha256', 'text', true],
        ['updated_at', 'timestamp with time zone', true],
      ]);
      expect(SCOPED_TABLES).toContain('user_images');
    });

    it('forces row-level security under exactly one tenant_isolation policy', async () => {
      expect((await rowSecurityOf(db.owner)).find((row) => row.table === 'user_images')).toEqual({
        table: 'user_images',
        enabled: true,
        forced: true,
      });
      expect((await policiesOf(db.owner)).filter((policy) => policy.table === 'user_images')).toEqual([
        {
          table: 'user_images',
          name: 'tenant_isolation',
          permissive: true,
          command: '*',
          roles: '{0}',
          using: POLICY_EXPRESSION,
          check: POLICY_EXPRESSION,
        },
      ]);
    });

    it('keys one image of each kind per user, and references its user within the tenant', async () => {
      const own = (await keysOf(db.owner)).filter((key) => key.table === 'user_images');
      expect(own.filter((key) => key.kind === 'p').map((key) => [key.name, key.columns])).toEqual([
        ['user_images_pkey', ['tenant_id', 'user_id', 'kind']],
      ]);
      expect(own.filter((key) => key.kind === 'f').map((key) => [key.columns, key.references])).toEqual(
        expect.arrayContaining([
          [['tenant_id', 'user_id'], { table: 'users', columns: ['tenant_id', 'id'] }],
          [['tenant_id'], { table: 'tenants', columns: ['id'] }],
        ]),
      );
      await addUser(tdb, 'u-0026-img');
      await addPhoto(tdb, 'u-0026-img');
      expect(await outcome(addPhoto(tdb, 'u-0026-img'))).toBe('23505');
      expect(
        await outcome(
          tdb.query(
            "insert into user_images (user_id, kind, content_type, data, sha256) values ('u-0026-img', 'banner', 'image/webp', '\\x00', 's')",
          ),
        ),
      ).toBe('23514');
      expect(await outcome(addPhoto(tdb, 'u-0026-nobody'))).toBe('23503');
    });

    it('goes with its user', async () => {
      await addUser(tdb, 'u-0026-gone');
      await addPhoto(tdb, 'u-0026-gone');
      await tdb.query("delete from users where id = 'u-0026-gone'");
      expect(
        (await tdb.query<{ n: number }>("select count(*)::int as n from user_images where user_id = 'u-0026-gone'"))
          .rows,
      ).toEqual([{ n: 0 }]);
    });
  });
});
