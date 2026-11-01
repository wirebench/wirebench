import { afterAll, beforeAll, expect, it } from 'vitest';
import { auditLogModule } from '../../../src/audit-log/module.js';
import {
  CANONICAL_COLUMNS,
  chainHead,
  insertGenesis,
  listAuditEvents,
  readAnchor,
} from '../../../src/audit-log/repo.js';
import { ciTokenByHash } from '../../../src/ci-tokens/repo.js';
import { catchUrlBySecret, deleteCapturesBefore } from '../../../src/hooks/repo.js';
import { replaceCode, upsertPairing } from '../../../src/agent/repo.js';
import { isForeignKeyViolation, isUniqueViolation } from '../../../src/db/errors.js';
import { migrate, type Migration } from '../../../src/db/migrate.js';
import { findUserByEmail, tokenByHash, upsertCredential } from '../../../src/identity/repo.js';
import { putLicense, storedLicense } from '../../../src/licensing/repo.js';
import { main } from '../../../src/main.js';
import { BUILTIN_MODULES } from '../../../src/modules.js';
import { allMigrations } from '../../../src/serve.js';
import { openLog } from '../../../src/session-logs/repo.js';
import { ssoModule } from '../../../src/sso/module.js';
import { scimTokenByHash, upsertScimUser } from '../../../src/sso/repo.js';
import { upsertGrant } from '../../../src/teams/repo.js';
import { loadFixture0019, type Fixture0019 } from '../../fixtures/tenancy/load.js';
import {
  columnsOf,
  indexesOf,
  keysOf,
  objectNamesOf,
  policiesOf,
  POLICY_EXPRESSION,
  rowSecurityOf,
  SCOPED_TABLES,
  SETTING_EXPRESSION,
  tablesOf,
  unscopedDataMigrations,
  UNSCOPED_TABLES,
  type KeyInfo,
} from '../../helpers/catalog.js';
import { describeDb, TEST_DATABASE_URL, testDatabase } from '../../helpers/database.js';
import { createDatabase } from '../../../src/db/pool.js';
import { mkTempDir, removeTempDir } from '../../helpers/git.js';
import { signedInUser } from '../../helpers/identity.js';
import { asTenantQuerier, defaultTenantDb } from '../../helpers/tenancy.js';
import type { Querier } from '../../../src/db/querier.js';
import { TenantAdmin } from '../../../src/tenancy/directory.js';
import { tenantDbFactory, type TenantDb } from '../../../src/tenancy/tenant-db.js';
import { createTenancy, directoryOf } from '../../../src/tenancy/tenancy.js';
import { license, licensingHarness, testKeys } from '../../helpers/licensing.js';

/** Where the rollback test cuts 0020: the foreign keys are gone, no key is rebuilt yet. */
const HALFWAY = '-- Rule 2: primary keys';

/** A 0019 index or key kept until 0021 drops it (`0020`'s header). */
const KEPT = /_0019$/;

/** The migrations up to and including `version`. */
const upTo = (version: number, migrations: readonly Migration[]) => migrations.filter((m) => m.version <= version);

/** What 0020 adds beside the column: the two new tables (spec §19.2, §19.9). */
const NEW_TABLES = ['host_leases', 'tenants'];

/** The sealed audit rows as stored: their place, their link, their bytes and their physical row. */
const SEALED_ROWS = `select ${CANONICAL_COLUMNS}, chain_seq::text as seq, encode(chain_hash, 'hex') as hash,
    ctid::text as ctid, xmin::text as xmin
  from audit_events where chain_seq is not null order by chain_seq`;

type Snapshot = Awaited<ReturnType<typeof snapshot>>;

async function snapshot(db: Parameters<typeof tablesOf>[0]) {
  return {
    tables: await tablesOf(db),
    columns: await columnsOf(db),
    keys: await keysOf(db),
    indexes: await indexesOf(db),
  };
}

/**
 * Plan Task 4 (guard 3, first half, spec §19.8): migration 0020 over the frozen 0019 fixture. No policy yet,
 * so every check here reads the catalog and the rows; 0021's forced policy has its own half.
 */
describeDb('migration 0020 on the frozen 0019 fixture (hosted spec §19.3, §19.10)', () => {
  let db: Awaited<ReturnType<typeof testDatabase>>;
  let dataDir: string;
  let fixture: Fixture0019;
  let before: Snapshot;
  let namesBefore: string[];
  let countsBefore: Record<string, number>;
  let sealedBefore: Record<string, unknown>[];
  let migration0020: Migration;
  let afterFailure: Snapshot;
  let tenantId: string;
  let after: Snapshot;
  let filenodesBefore: Record<string, string>;
  /** The default tenant's database: the app role's reads go through a unit, as every module's do. */
  let tdb: TenantDb;

  /** Each table's storage file: a rewrite always gives it a new one (M2 of the Task 4 review). */
  const filenodes = async () =>
    Object.fromEntries(
      (
        await db.owner.query<{ table: string; node: string }>(
          `select relname as table, relfilenode::text as node from pg_class
            where relnamespace = to_regnamespace(current_schema()) and relkind = 'r'`,
        )
      ).rows.map((row) => [row.table, row.node]),
    );

  const counts = async (tables: readonly string[]) => {
    const out: Record<string, number> = {};
    for (const table of tables) {
      out[table] = Number((await db.owner.query<{ n: string }>(`select count(*) as n from ${table}`)).rows[0]!.n);
    }
    return out;
  };

  beforeAll(async () => {
    db = await testDatabase({ migrated: false });
    dataDir = await mkTempDir('wbs-tenancy-0020-');
    fixture = await loadFixture0019(db.owner, dataDir);
    before = await snapshot(db.owner);
    namesBefore = await objectNamesOf(db.owner);
    countsBefore = await counts(before.tables);
    sealedBefore = (await db.owner.query(SEALED_ROWS)).rows;

    // Up to 0020 only: 0021's forced policy has the describe below.
    const migrations = upTo(20, await allMigrations(BUILTIN_MODULES));
    migration0020 = migrations.find((m) => m.version === 20)!;
    // A crash rolls 0020 back whole, and the next start runs it again (§19.10). It fails halfway: after the
    // column and the foreign keys are gone, before any key is rebuilt.
    const halfway = migration0020.sql.indexOf(HALFWAY);
    expect(halfway).toBeGreaterThan(0);
    await expect(
      db.owner.transaction(async (tx) => {
        await tx.query(migration0020.sql.slice(0, halfway));
        expect(
          (
            await tx.query(
              "select 1 from pg_constraint where conname = 'workspaces_team_id_fkey' and connamespace = to_regnamespace(current_schema())",
            )
          ).rowCount,
        ).toBe(0);
        await tx.query('select 1 / 0');
      }),
    ).rejects.toMatchObject({ code: '22012' });
    afterFailure = await snapshot(db.owner);
    filenodesBefore = await filenodes();

    const started = performance.now();
    const { applied } = await migrate(db.owner, migrations);
    // Surfaced in the log: the fixture's time, beside the scaled one the perf test records.
    console.info(`[tenancy] 0020 on the 0019 fixture: ${(performance.now() - started).toFixed(0)} ms`);
    expect(applied).toEqual([20]);
    await db.grant();
    tenantId = (await db.owner.query<{ id: string }>('select default_tenant_id as id from server_identity')).rows[0]!
      .id;
    tdb = await defaultTenantDb(db);
    after = await snapshot(db.owner);
  });
  afterAll(async () => {
    await db.close();
    await removeTempDir(dataDir);
  });

  const scoped = () => after.tables.filter((table) => !UNSCOPED_TABLES.includes(table));
  const keysOfKind = (kind: KeyInfo['kind']) => after.keys.filter((key) => key.kind === kind);

  it('leaves the 0019 catalog exactly as it was when it fails halfway through', () => {
    expect(afterFailure).toEqual(before);
  });

  it('creates the default tenant, names it in server_identity, and starts the file step', async () => {
    const tenants = await tdb.query('select id, slug, name, edition, status, region, seats, data_key from tenants');
    expect(tenants.rows).toEqual([
      {
        id: tenantId,
        slug: 'default',
        name: 'Default',
        edition: 'community',
        status: 'active',
        region: 'eu',
        seats: null,
        data_key: null,
      },
    ]);
    const identity = await tdb.query('select default_tenant_id, tenancy_step from server_identity');
    expect(identity.rows).toEqual([{ default_tenant_id: tenantId, tenancy_step: 'files' }]);
    expect(after.tables).toEqual([...before.tables, ...NEW_TABLES].sort());
  });

  it('gives every table off the allowlist tenant_id uuid not null, defaulting to the default tenant', () => {
    expect(scoped()).toHaveLength(36);
    const tenantColumns = after.columns.filter((c) => c.column === 'tenant_id');
    expect(tenantColumns.map((c) => c.table).sort()).toEqual(scoped());
    for (const column of tenantColumns) {
      expect(column, column.table).toMatchObject({ type: 'uuid', notNull: true, default: `'${tenantId}'::uuid` });
    }
    // Each references tenants, so a row can only name a tenant that exists.
    const toTenants = keysOfKind('f').filter((key) => key.references?.table === 'tenants');
    expect(
      toTenants
        .filter((key) => key.table !== 'server_identity')
        .map((key) => key.table)
        .sort(),
    ).toEqual(scoped());
    for (const key of toTenants) expect(key.references!.columns).toEqual(['id']);
  });

  it('keeps every other column of 0019, in order', () => {
    const live = after.columns.filter(
      (c) => c.column !== 'tenant_id' && !NEW_TABLES.includes(c.table) && c.table !== 'server_identity',
    );
    expect(live).toEqual(before.columns.filter((c) => c.table !== 'server_identity'));
  });

  it('leads every unique index and every non-minted primary key with tenant_id', () => {
    const unique = after.keys.filter(
      (key) =>
        (key.kind === 'p' || key.kind === 'u' || key.kind === 'i') &&
        scoped().includes(key.table) &&
        !KEPT.test(key.name),
    );
    // A lone `id` the server mints stays the key (rule 2); workspaces' id comes from the desktop.
    const minted = unique.filter((key) => key.kind === 'p' && key.columns.length === 1 && key.columns[0] === 'id');
    expect(minted.map((key) => key.table)).not.toContain('workspaces');
    for (const key of unique.filter((k) => !minted.includes(k))) {
      expect(key.columns[0], `${key.table}.${key.name}`).toBe('tenant_id');
    }
    const pkeyOf = (table: string) => unique.find((key) => key.table === table && key.kind === 'p')!.columns;
    expect(pkeyOf('workspaces')).toEqual(['tenant_id', 'id']);
    expect(pkeyOf('license')).toEqual(['tenant_id']);
    expect(pkeyOf('audit_chain_anchor')).toEqual(['tenant_id']);
    expect(pkeyOf('host_leases')).toEqual(['tenant_id', 'user_id']);
  });

  it('keeps the singleton and only_row columns, with their check and default (rule 5)', async () => {
    const kept = after.columns.filter((c) => c.column === 'singleton' || c.column === 'only_row');
    expect(kept.map((c) => [c.table, c.column, c.default])).toEqual([
      ['audit_chain_anchor', 'only_row', 'true'],
      ['license', 'singleton', 'true'],
      ['server_identity', 'singleton', 'true'],
    ]);
    const checks = await db.owner.query<{ name: string }>(
      `select conname as name from pg_constraint
        where connamespace = to_regnamespace(current_schema()) and contype = 'c'
          and conname in ('license_singleton_check', 'audit_chain_anchor_only_row_check')
        order by 1`,
    );
    expect(checks.rows.map((row) => row.name)).toEqual([
      'audit_chain_anchor_only_row_check',
      'license_singleton_check',
    ]);
  });

  it('makes every foreign key between scoped tables composite, nulling only its own column', () => {
    const between = keysOfKind('f').filter((key) => key.references?.table !== 'tenants');
    // The 41 of 0019, and host_leases'.
    expect(between).toHaveLength(42);
    for (const key of between) {
      expect(key.columns[0], key.name).toBe('tenant_id');
      expect(key.references!.columns[0], key.name).toBe('tenant_id');
      expect(key.columns, key.name).toHaveLength(key.references!.columns.length);
      if (key.definition.includes('SET NULL')) expect(key.definition, key.name).toMatch(/SET NULL \(\w+\)/);
    }
    // Every 0019 foreign key is among them, under its own name.
    const before0019 = before.keys.filter((key) => key.kind === 'f').map((key) => key.name);
    expect(between.map((key) => key.name)).toEqual(expect.arrayContaining(before0019));
  });

  it('keeps the 0019 name of every key, index and foreign key (rule 6)', async () => {
    expect(await objectNamesOf(db.owner)).toEqual(expect.arrayContaining(namesBefore));
    // The names routes map, spelled out.
    for (const name of [
      'users_email_lower_key',
      'workspaces_pkey',
      'workspaces_team_id_fkey',
      'team_members_team_id_fkey',
      'catch_urls_workspace_id_fkey',
      'captures_catch_url_id_fkey',
      'teams_name_lower',
      'invitations_one_open_per_email',
      'workspaces_team_name_lower',
      'catch_urls_workspace_name_lower',
      'ci_tokens_workspace_name_lower',
      'schedules_workspace_name_lower',
      'scim_tokens_name_lower',
      'scim_groups_display_name_lower',
      'agent_pairing_codes_pkey',
    ]) {
      expect(namesBefore, name).toContain(name);
    }
  });

  it('leads the listing indexes not led by a parent id with tenant_id (rule 4)', () => {
    const listing = after.indexes.filter(
      (index) => !index.unique && scoped().includes(index.table) && !KEPT.test(index.name),
    );
    const parentLed = [
      'audit_events_actor_at',
      'audit_events_team_at',
      'audit_events_workspace_at',
      'captures_catch_url_id_id',
      'ci_tokens_workspace_id',
      'device_tokens_user_id',
      'oidc_identities_user_id',
      'provisioned_memberships_group_id',
      'saml_identities_user_id',
      'schedule_runs_schedule',
      'scim_group_members_user_id',
      'scim_groups_team_id',
      'session_logs_workspace_id',
      'team_invitations_team_id',
      'team_members_user_id',
      'workspace_grants_user_id',
    ];
    for (const index of listing) {
      const columns = /\((.*)\)/.exec(index.definition)![1]!;
      if (parentLed.includes(index.name)) {
        expect(index.definition).toBe(before.indexes.find((b) => b.name === index.name)!.definition);
      } else {
        expect(columns, index.name).toMatch(/^tenant_id,/);
      }
    }
    expect(listing.map((index) => index.name)).toEqual(expect.arrayContaining(parentLed));
  });

  it('keeps every 0019 index it rebuilt as <name>_0019, on the same columns, until 0021', () => {
    const rebuilt = before.indexes.filter((index) => {
      const now = after.indexes.find((a) => a.name === index.name);
      return now === undefined || now.definition !== index.definition;
    });
    expect(rebuilt.length).toBeGreaterThan(50);
    for (const index of rebuilt) {
      const kept = after.indexes.find((a) => a.name === `${index.name}_0019`);
      expect(kept, index.name).toBeDefined();
      // A unique key a route maps, and a primary key, keep a non-unique copy (0020's header).
      const asBefore = index.definition.replace(` INDEX ${index.name} `, ` INDEX ${index.name}_0019 `);
      expect([asBefore, asBefore.replace('CREATE UNIQUE INDEX', 'CREATE INDEX')], index.name).toContain(
        kept!.definition,
      );
    }
    // The unique ones a route maps are never kept unique: their violation must keep the 0019 name. Nor are an
    // upsert's arbiters: a racing insert would meet the copy and raise instead of taking its conflict path.
    for (const name of [
      'users_email_lower_key',
      'teams_name_lower',
      'workspaces_pkey',
      'agent_pairing_codes_pkey',
      'session_logs_workspace_id_user_id_client_log_id_key',
      'agent_pairings_user_id_agent_id_key',
      'agent_pairing_codes_user_id_key',
    ]) {
      expect(after.indexes.find((a) => a.name === `${name}_0019`)?.unique, name).toBe(false);
    }
  });

  it('serves the hot lookups from an index until 0021', async () => {
    const plans: string[] = [];
    const explaining = {
      query: async <R extends Record<string, unknown>>(text: string, params?: readonly unknown[]) => {
        await db.owner.transaction(async (tx) => {
          await tx.query('set local enable_seqscan = off');
          const rows = await tx.query<{ 'QUERY PLAN': string }>(`explain ${text}`, params);
          plans.push(rows.rows.map((row) => row['QUERY PLAN']).join('\n'));
        });
        return { rows: [] as R[], rowCount: 0 };
      },
    };
    await tokenByHash(asTenantQuerier(explaining), 'no-such-hash');
    await findUserByEmail(asTenantQuerier(explaining), 'admin@example.com');
    await chainHead(asTenantQuerier(explaining));
    await listAuditEvents(asTenantQuerier(explaining), {}, { limit: 50 });
    await deleteCapturesBefore(asTenantQuerier(explaining), new Date(), 100);
    await catchUrlBySecret(asTenantQuerier(explaining), 'no-such-secret');
    await ciTokenByHash(asTenantQuerier(explaining), 'no-such-hash');
    await scimTokenByHash(asTenantQuerier(explaining), 'no-such-hash');
    const [token, email, head, listing, retention, secret, ciToken, scimToken] = plans;
    expect(token).toContain('device_tokens_token_hash_key_0019');
    expect(email).toContain('users_email_lower_key_0019');
    expect(head).toContain('audit_events_chain_seq_0019');
    expect(listing).toMatch(/audit_events_\w+_0019/);
    expect(retention).toMatch(/captures_\w+_0019/);
    // On the fixture's few rows the planner may scan the composite index on its second column as cheaply as the
    // copy; either way it is an index, which is what the hot path needs until 0021.
    expect(secret).toMatch(/Index Scan using catch_urls_secret(_0019)? /);
    expect(ciToken).toMatch(/Index Scan using ci_tokens_token_hash_key(_0019)? /);
    expect(scimToken).toMatch(/Index Scan using scim_tokens_token_hash_key(_0019)? /);
    for (const plan of plans) expect(plan).not.toMatch(/Seq Scan/);
  });

  it('rewrites no table: every storage file is the same, and each tenant_id is a missing-value default', async () => {
    const now = await filenodes();
    for (const table of before.tables) expect(now[table], table).toBe(filenodesBefore[table]);
    const missing = await db.owner.query<{ table: string; missing: boolean }>(
      `select c.relname as table, a.atthasmissing as missing from pg_attribute a join pg_class c on c.oid = a.attrelid
        where c.relnamespace = to_regnamespace(current_schema()) and c.relkind = 'r' and a.attname = 'tenant_id'
        order by 1`,
    );
    for (const row of missing.rows) expect(row.missing, row.table).toBe(!NEW_TABLES.includes(row.table));
  });

  it('puts every row in the default tenant, and loses none', async () => {
    // The ledger gains 0020's row; every other table keeps its count.
    expect(await counts(before.tables)).toEqual({
      ...countsBefore,
      schema_migrations: countsBefore.schema_migrations! + 1,
    });
    for (const table of scoped().filter((t) => !NEW_TABLES.includes(t))) {
      const rows = await tdb.query<{ other: string; total: string }>(
        `select count(*) filter (where tenant_id <> $1)::text as other, count(*)::text as total from ${table}`,
        [tenantId],
      );
      expect(rows.rows[0], table).toEqual({ other: '0', total: String(countsBefore[table]) });
      expect(Number(rows.rows[0]!.total), table).toBeGreaterThan(0);
    }
  });

  it('rewrites no sealed audit row: same bytes, seq, link and physical row', async () => {
    const sealed = (await db.owner.query(SEALED_ROWS)).rows;
    expect(sealed).toHaveLength(Number(fixture.chain.lastSeq) - Number(fixture.chain.firstSeq) + 1);
    expect(sealed).toEqual(sealedBefore);
  });

  it('is applied once: a second migrate applies nothing, and the grants apply again unchanged', async () => {
    expect((await migrate(db.owner, upTo(20, await allMigrations(BUILTIN_MODULES)))).applied).toEqual([]);
    const grants = () =>
      db.owner.query(
        `select table_name, privilege_type from information_schema.role_table_grants
          where table_schema = current_schema() and grantee = 'wirebench_app' order by 1, 2`,
      );
    const first = (await grants()).rows;
    await db.grant();
    expect((await grants()).rows).toEqual(first);
    expect(await snapshot(db.owner)).toEqual(after);
  });

  it("maps the routes' constraint names on the rebuilt keys", async () => {
    const [workspace] = (await tdb.query<{ id: string; team_id: string }>('select id, team_id from workspaces')).rows;
    const caught = async (sql: string, params: unknown[]) =>
      tdb.query(sql, params).then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(
      isUniqueViolation(
        await caught("insert into users (id, email, email_lower, display_name) values ('X1', $1, $2, 'x')", [
          'ADMIN@example.com',
          'admin@example.com',
        ]),
        'users_email_lower_key',
      ),
    ).toBe(true);
    expect(
      isUniqueViolation(
        await caught("insert into workspaces (id, name, team_id) values ($1, 'Copy', $2)", [
          workspace!.id,
          workspace!.team_id,
        ]),
        'workspaces_pkey',
      ),
    ).toBe(true);
    expect(
      isForeignKeyViolation(
        await caught("insert into workspaces (id, name, team_id) values ('W-new', 'New', 'no-such-team')", []),
        'workspaces_team_id_fkey',
      ),
    ).toBe(true);
    expect(
      isForeignKeyViolation(
        await caught("insert into team_members (team_id, user_id, role) values ('no-such-team', $1, 'member')", [
          fixture.users.alice,
        ]),
        'team_members_team_id_fkey',
      ),
    ).toBe(true);
    expect(
      isForeignKeyViolation(
        await caught(
          "insert into catch_urls (id, workspace_id, name, secret) values ('C-new', 'no-such', 'n', 's')",
          [],
        ),
        'catch_urls_workspace_id_fkey',
      ),
    ).toBe(true);
  });

  it("runs every module's on conflict upsert against the fixture's rows", async () => {
    const at = new Date('2026-10-30T12:00:00.000Z');
    const { admin } = fixture.users;
    // identity: local_credentials, by (tenant_id, user_id); the admin has a password in the fixture.
    await upsertCredential(tdb, admin, 'scrypt$replaced', at);
    expect((await tdb.query('select password_hash from local_credentials where user_id = $1', [admin])).rows).toEqual([
      { password_hash: 'scrypt$replaced' },
    ]);
    // teams-access: workspace_grants, by (tenant_id, workspace_id, user_id).
    const [grant] = (await tdb.query<{ workspace_id: string; user_id: string }>('select * from workspace_grants')).rows;
    await upsertGrant(tdb, {
      workspaceId: grant!.workspace_id,
      userId: grant!.user_id,
      role: 'admin',
      at,
    });
    expect(
      (
        await tdb.query('select role from workspace_grants where workspace_id = $1 and user_id = $2', [
          grant!.workspace_id,
          grant!.user_id,
        ])
      ).rows,
    ).toEqual([{ role: 'admin' }]);
    // licensing: the license, by tenant_id, its new primary key.
    await putLicense(tdb, { text: 'wbl1.replaced', licenseId: 'L-new', installedBy: admin, at });
    expect(await storedLicense(tdb)).toMatchObject({ text: 'wbl1.replaced', licenseId: 'L-new' });
    expect((await tdb.query('select count(*)::int as n from license')).rows).toEqual([{ n: 1 }]);
    // audit-log: the anchor, by tenant_id; the fixture's anchor wins.
    const anchor = await readAnchor(tdb);
    expect(await insertGenesis(tdb, fixture.keys.auditChainKey)).toEqual(anchor);
    // sso: scim_users, by (tenant_id, user_id).
    const [scimUser] = (await tdb.query<{ user_id: string }>('select user_id from scim_users')).rows;
    await upsertScimUser(tdb, scimUser!.user_id, 'ext-replaced', at);
    expect(
      (await tdb.query('select external_id from scim_users where user_id = $1', [scimUser!.user_id])).rows,
    ).toEqual([{ external_id: 'ext-replaced' }]);
    // session-logs: an upload resumed under the same client id finds the fixture's log.
    const [log] = (
      await tdb.query<Record<string, unknown>>(
        `select id, workspace_id, user_id, client_log_id, host_id, host_name, address, port, ssh_user, started_at
          from session_logs`,
      )
    ).rows;
    const resumed = await openLog(tdb, {
      id: 'LOG-new',
      workspaceId: log!.workspace_id as string,
      userId: log!.user_id as string,
      clientLogId: log!.client_log_id as string,
      hostId: log!.host_id as string,
      hostName: log!.host_name as string,
      address: log!.address as string,
      port: log!.port as number,
      user: log!.ssh_user as string,
      startedAt: (log!.started_at as Date).toISOString(),
      at,
    });
    expect(resumed).toMatchObject({ created: false, log: { id: log!.id } });
    // agent: the code by (tenant_id, user_id), and the pairing by (tenant_id, user_id, agent_id).
    const [code] = (await tdb.query<{ user_id: string }>('select user_id from agent_pairing_codes')).rows;
    await replaceCode(tdb, { userId: code!.user_id, codeHash: 'hash-replaced', expiresAt: at });
    expect((await tdb.query('select code_hash from agent_pairing_codes')).rows).toEqual([
      { code_hash: 'hash-replaced' },
    ]);
    const [pairing] = (
      await tdb.query<{ id: string; user_id: string; agent_id: string }>(
        'select id, user_id, agent_id from agent_pairings',
      )
    ).rows;
    const upserted = await upsertPairing(tdb, {
      id: 'P-new',
      userId: pairing!.user_id,
      agentId: pairing!.agent_id,
      publicKey: 'key-replaced',
      port: 4999,
      sshOptIn: false,
      at,
    });
    expect(upserted).toMatchObject({ id: pairing!.id, port: 4999 });
  });

  it('starts a server over the migrated fixture, which still answers 409 for a duplicate email', async () => {
    const keys = testKeys();
    const h = await licensingHarness(keys, {
      db,
      extra: (clock) => [
        auditLogModule({ now: () => clock.now }),
        ssoModule({ now: () => clock.now, sweepIntervalMs: 0 }),
      ],
    });
    try {
      const root = await signedInUser(h, { email: 'root-0020@example.com', serverAdmin: true });
      // The license upsert through its route, over the fixture's row.
      const put = await h.app.inject({
        method: 'PUT',
        url: '/api/v1/license',
        headers: root.headers,
        payload: { license: license(keys, { edition: 'enterprise' }) },
      });
      expect(put.statusCode, put.body).toBe(200);
      const created = await h.app.inject({
        method: 'POST',
        url: '/api/v1/scim-tokens',
        headers: root.headers,
        payload: { name: 'IdP 0020' },
      });
      expect(created.statusCode, created.body).toBe(201);
      const { token } = created.json<{ token: string }>();
      const scim = (userName: string) =>
        h.app.inject({
          method: 'POST',
          url: '/scim/v2/Users',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/scim+json' },
          payload: JSON.stringify({ schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], userName }),
        });
      const fresh = await scim('carol-0020@example.com');
      expect(fresh.statusCode, fresh.body).toBe(201);
      // The fixture's admin, in another case.
      const taken = await scim('ADMIN@example.com');
      expect(taken.statusCode, taken.body).toBe(409);
      expect(taken.json()).toMatchObject({ scimType: 'uniqueness' });
    } finally {
      await h.close();
    }
  });
});

/**
 * Plan Task 17 (guard 3 complete, spec §19.4, §19.8): `0021` over the frozen fixture, after `0020`. Every scoped
 * table is forced under one policy, every `tenant_id` defaults to the setting, the `_0019` copies are gone, and no
 * row is lost or rewritten. The owner is under the policy too, so it reads a tenant's rows only inside one.
 */
describeDb('migration 0021 on the frozen 0019 fixture: forced isolation (hosted spec §19.4, §19.8 guard 3)', () => {
  let db: Awaited<ReturnType<typeof testDatabase>>;
  let dataDir: string;
  let fixture: Fixture0019;
  let namesBefore: string[];
  let countsBefore: Record<string, number>;
  let sealedBefore: Record<string, unknown>[];
  let filenodesBefore: Record<string, string>;
  let tenantId: string;
  let tdb: TenantDb;

  /** Each table's storage file, read from the catalog (no policy applies to it). */
  const filenodes = async () =>
    Object.fromEntries(
      (
        await db.owner.query<{ table: string; node: string }>(
          `select relname as table, relfilenode::text as node from pg_class
            where relnamespace = to_regnamespace(current_schema()) and relkind = 'r'`,
        )
      ).rows.map((row) => [row.table, row.node]),
    );
  /** `sql` as the owner in one transaction with `tenant` set, or none when it is `''`. */
  const asOwner = <R extends Record<string, unknown>>(tenant: string, sql: string, params: unknown[] = []) =>
    db.owner.transaction(async (tx) => {
      await tx.query("select set_config('wirebench.tenant_id', $1, true)", [tenant]);
      return (await tx.query<R>(sql, params)).rows;
    });
  const countAsOwner = async (tenant: string, table: string) =>
    Number((await asOwner<{ n: string }>(tenant, `select count(*)::text as n from ${table}`))[0]!.n);

  beforeAll(async () => {
    db = await testDatabase({ migrated: false });
    dataDir = await mkTempDir('wbs-tenancy-0021-');
    fixture = await loadFixture0019(db.owner, dataDir);
    namesBefore = await objectNamesOf(db.owner);
    // At 0019 there is no policy: the owner counts every row.
    countsBefore = {};
    for (const table of SCOPED_TABLES.filter((t) => t !== 'host_leases')) {
      countsBefore[table] = Number(
        (await db.owner.query<{ n: string }>(`select count(*)::text as n from ${table}`)).rows[0]!.n,
      );
    }
    sealedBefore = (await db.owner.query(SEALED_ROWS)).rows;
    filenodesBefore = await filenodes();
    const started = performance.now();
    const { applied } = await migrate(db.owner, await allMigrations(BUILTIN_MODULES));
    console.info(`[tenancy] 0020 and 0021 on the 0019 fixture: ${(performance.now() - started).toFixed(0)} ms`);
    expect(applied).toEqual([20, 21]);
    await db.grant();
    tenantId = (await db.owner.query<{ id: string }>('select default_tenant_id as id from server_identity')).rows[0]!
      .id;
    tdb = await defaultTenantDb(db);
  });
  afterAll(async () => {
    await db.close();
    await removeTempDir(dataDir);
  });

  it('enables and forces row-level security on the 36 scoped tables, and on no other', async () => {
    const security = await rowSecurityOf(db.owner);
    const on = security.filter((row) => row.enabled && row.forced).map((row) => row.table);
    expect(on).toEqual([...SCOPED_TABLES].sort());
    for (const row of security.filter((r) => !SCOPED_TABLES.includes(r.table))) {
      expect(row, row.table).toEqual({ table: row.table, enabled: false, forced: false });
    }
    expect(security.map((row) => row.table).sort()).toEqual([...SCOPED_TABLES, ...UNSCOPED_TABLES].sort());
  });

  it('gives each scoped table exactly one policy: permissive, for all, to public, the setting both ways', async () => {
    const policies = await policiesOf(db.owner);
    expect(policies.map((policy) => policy.table)).toEqual([...SCOPED_TABLES].sort());
    for (const policy of policies) {
      expect(policy, policy.table).toEqual({
        table: policy.table,
        name: 'tenant_isolation',
        permissive: true,
        command: '*',
        roles: '{0}',
        using: POLICY_EXPRESSION,
        check: POLICY_EXPRESSION,
      });
    }
  });

  it('defaults every tenant_id to the setting, so an insert outside a unit has no tenant', async () => {
    const tenantColumns = (await columnsOf(db.owner)).filter((column) => column.column === 'tenant_id');
    expect(tenantColumns.map((column) => column.table).sort()).toEqual([...SCOPED_TABLES].sort());
    for (const column of tenantColumns) {
      expect(column, column.table).toMatchObject({ type: 'uuid', notNull: true, default: SETTING_EXPRESSION });
    }
  });

  it("adds the forwarder's lease to the queue, nullable and with no default, after the 0020 columns", async () => {
    const queue = (await columnsOf(db.owner)).filter((column) => column.table === 'audit_forward_queue');
    expect(queue.slice(-2)).toEqual([
      { table: 'audit_forward_queue', column: 'lease_id', type: 'text', notNull: false, default: null },
      {
        table: 'audit_forward_queue',
        column: 'leased_until',
        type: 'timestamp with time zone',
        notNull: false,
        default: null,
      },
    ]);
  });

  it('drops every _0019 copy 0020 kept, and keeps every 0019 name', async () => {
    const names = await objectNamesOf(db.owner);
    expect(names.filter((name) => KEPT.test(name))).toEqual([]);
    expect(names).toEqual(expect.arrayContaining(namesBefore));
  });

  it('keeps every row, in the default tenant, which the owner reads only inside that tenant', async () => {
    for (const [table, count] of Object.entries(countsBefore)) {
      expect(count, table).toBeGreaterThan(0);
      expect(await countAsOwner(tenantId, table), table).toBe(count);
      // Forced: the owner is under the policy as well.
      expect(await countAsOwner('', table), table).toBe(0);
    }
  });

  it('rewrites no table, and no sealed audit row: same bytes, seq, link and physical row', async () => {
    const now = await filenodes();
    for (const [table, node] of Object.entries(filenodesBefore)) expect(now[table], table).toBe(node);
    expect(await asOwner(tenantId, SEALED_ROWS)).toEqual(sealedBefore);
    expect(sealedBefore).toHaveLength(Number(fixture.chain.lastSeq) - Number(fixture.chain.firstSeq) + 1);
  });

  it('passes admin audit verify with the test chain key, as the app role', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(['admin', 'audit', 'verify'], {
      stdout: { write: (text: string) => out.push(text) },
      stderr: { write: (text: string) => err.push(text) },
      env: {
        WIREBENCH_SERVER_DATABASE_URL: db.url,
        WIREBENCH_SERVER_PUBLIC_URL: 'https://wirebench.test',
        WIREBENCH_SERVER_AUDIT_CHAIN_KEY: fixture.keys.auditChainKey,
      },
    });
    expect({ code, err: err.join('') }).toEqual({ code: 0, err: '' });
    expect(out.join('')).toContain(`seq ${fixture.chain.firstSeq} to ${fixture.chain.lastSeq}`);
  });

  it('runs for_each_tenant once in each tenant as the owner; the app role may run neither function', async () => {
    const other = await new TenantAdmin(db, directoryOf(createTenancy(db))).create({ slug: 'other', name: 'Other' });
    const otherDb = tenantDbFactory(db)(other.scope);
    await otherDb.query(
      "insert into users (id, email, email_lower, display_name) values ('U-other', 'o@example.com', 'o@example.com', 'O')",
    );
    try {
      await db.owner.transaction(async (tx) => {
        await tx.query(`select for_each_tenant($$update users set display_name = 'each ' || tenant_id::text$$)`);
        // The setting is what it was before the loop: none.
        expect((await tx.query("select current_setting('wirebench.tenant_id', true) as s")).rows).toEqual([{ s: '' }]);
      });
      expect(await asOwner(other.scope.tenantId, 'select display_name from users')).toEqual([
        { display_name: `each ${other.scope.tenantId}` },
      ]);
      const defaults = await asOwner<{ display_name: string }>(tenantId, 'select display_name from users');
      expect(defaults.length).toBe(countsBefore.users);
      for (const row of defaults) expect(row.display_name).toBe(`each ${tenantId}`);
      await expect(db.query("select for_each_tenant('select 1')")).rejects.toMatchObject({ code: '42501' });
      await expect(db.query("select tenant_scope('tenants'::regclass)")).rejects.toMatchObject({ code: '42501' });
    } finally {
      await otherDb.query("delete from users where id = 'U-other'");
      await db.owner.query('delete from tenants where id = $1', [other.scope.tenantId]);
    }
  });

  it('as a role that bypasses the policy, a for_each_tenant statement reaches each tenant once only with the predicate (M1)', async () => {
    const other = await new TenantAdmin(db, directoryOf(createTenancy(db))).create({ slug: 'bypass', name: 'Bypass' });
    const otherDb = tenantDbFactory(db)(other.scope);
    await otherDb.query(
      "insert into users (id, email, email_lower, display_name) values ('U-bypass', 'b@example.com', 'b@example.com', 'B')",
    );
    // The admin URL is a superuser, as the default compose owner is: the forced policy does not hold it.
    const url = new URL(TEST_DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${db.schema}`);
    const superuser = createDatabase(url.toString());
    /** How many times `statement` reached each user's row, in one transaction that is rolled back. */
    const reached = async (statement: string) => {
      let counts: Record<string, number> = {};
      await expect(
        superuser.transaction(async (tx) => {
          await tx.query("update users set display_name = '0'");
          await tx.query('select for_each_tenant($1)', [statement]);
          const rows = await tx.query<{ id: string; n: string }>('select id, display_name as n from users');
          counts = Object.fromEntries(rows.rows.map((row) => [row.id, Number(row.n)]));
          throw new Error('roll back');
        }),
      ).rejects.toThrow('roll back');
      return counts;
    };
    try {
      const tenants = Number(
        (await superuser.query<{ n: string }>('select count(*)::text as n from tenants')).rows[0]!.n,
      );
      expect(tenants).toBeGreaterThan(1);
      const bump = 'update users set display_name = (display_name::int + 1)::text';
      // Without the predicate every row is reached once per tenant.
      const unfiltered = await reached(bump);
      for (const n of Object.values(unfiltered)) expect(n).toBe(tenants);
      // With it, each row once: in its own tenant's pass.
      const filtered = await reached(
        `${bump} where tenant_id = nullif(current_setting('wirebench.tenant_id', true), '')::uuid`,
      );
      expect(Object.keys(filtered)).toContain('U-bypass');
      for (const n of Object.values(filtered)) expect(n).toBe(1);
    } finally {
      await superuser.close();
      await otherDb.query("delete from users where id = 'U-bypass'");
      await db.owner.query('delete from tenants where id = $1', [other.scope.tenantId]);
    }
  });

  it('a data migration bracketed with no force and force reaches the rows, and leaves the table forced', async () => {
    const forced = async (tx: Querier) =>
      (
        await tx.query<{ forced: boolean }>(
          "select relforcerowsecurity as forced from pg_class where oid = 'users'::regclass",
        )
      ).rows[0]!.forced;
    // The owner's own pool, past the test helper's refusal: this is the unbracketed back-fill the lint exists for.
    const owner = createDatabase(db.ownerUrl);
    try {
      await expect(
        owner.transaction(async (tx) => {
          // Without either, a back-fill touches no row and still succeeds (spec §19.4).
          expect((await tx.query("update users set display_name = 'unbracketed'")).rowCount).toBe(0);
          await tx.query('alter table users no force row level security');
          expect((await tx.query("update users set display_name = 'bracketed'")).rowCount).toBe(countsBefore.users);
          await tx.query('alter table users force row level security');
          expect(await forced(tx)).toBe(true);
          throw new Error('roll back');
        }),
      ).rejects.toThrow('roll back');
    } finally {
      await owner.close();
    }
    expect(await forced(db.owner)).toBe(true);
  });

  it('lints every data migration from 0022 on: a write to a scoped table runs per tenant or bracketed', async () => {
    const real = await allMigrations(BUILTIN_MODULES);
    expect(unscopedDataMigrations(real)).toEqual([]);
    const planted = (sql: string) => unscopedDataMigrations([...real, { version: 99, name: 'planted', sql }]);
    expect(planted("update users set display_name = 'x';")).toEqual([99]);
    expect(planted("-- for_each_tenant( in a comment\ninsert into audit_events (id) values ('x');")).toEqual([99]);
    expect(planted('do $$ begin delete from captures; end $$;')).toEqual([99]);
    // A per-tenant statement must name the setting itself, for a migration role the policy does not hold (M1).
    expect(planted("select for_each_tenant($$update users set display_name = 'x'$$);")).toEqual([99]);
    expect(
      planted(
        "select for_each_tenant($$update users set display_name = 'x' where tenant_id = nullif(current_setting('wirebench.tenant_id', true), '')::uuid$$);",
      ),
    ).toEqual([]);
    expect(
      planted(
        "select for_each_tenant('update users set display_name = ''x'' where tenant_id = nullif(current_setting(''wirebench.tenant_id'', true), '''')::uuid');",
      ),
    ).toEqual([]);
    // One filtered call does not cover another that is not.
    expect(
      planted(
        "select for_each_tenant($$update users set display_name = 'x' where tenant_id = nullif(current_setting('wirebench.tenant_id', true), '')::uuid$$);\nselect for_each_tenant($$update captures set rejected = true$$);",
      ),
    ).toEqual([99]);
    // A filtered call excuses only its own statement: a bare write beside it still runs outside every tenant (N2).
    expect(
      planted(
        "select for_each_tenant($$update users set display_name = 'x' where tenant_id = nullif(current_setting('wirebench.tenant_id', true), '')::uuid$$);\nupdate captures set rejected = true;",
      ),
    ).toEqual([99]);
    expect(
      planted(
        "alter table users no force row level security;\nupdate users set display_name = 'x';\nalter table users force row level security;",
      ),
    ).toEqual([]);
    // Only one half of the bracket is no bracket.
    expect(planted("alter table users no force row level security;\nupdate users set display_name = 'x';")).toEqual([
      99,
    ]);
    // A table no tenant owns is no data migration of a scoped table.
    expect(planted("update tenants set name = 'x';")).toEqual([]);
  });

  it('serves the hot lookups inside a unit from the indexes led by tenant_id, with no sequential scan', async () => {
    const plans: string[] = [];
    await tdb.transaction(async (tx) => {
      await tx.query('set local enable_seqscan = off');
      const explaining = asTenantQuerier({
        query: async <R extends Record<string, unknown>>(text: string, params?: readonly unknown[]) => {
          const rows = await tx.query<{ 'QUERY PLAN': string }>(`explain ${text}`, params);
          plans.push(rows.rows.map((row) => row['QUERY PLAN']).join('\n'));
          return { rows: [] as R[], rowCount: 0 };
        },
      });
      await tokenByHash(explaining, 'no-such-hash');
      await findUserByEmail(explaining, 'admin@example.com');
      await chainHead(explaining);
      await listAuditEvents(explaining, {}, { limit: 50 });
    });
    const [token, email, head, listing] = plans;
    expect(token).toMatch(/Index Scan using device_tokens_token_hash_key on device_tokens/);
    expect(email).toMatch(/Index Scan using users_email_lower_key on users/);
    expect(head).toMatch(/Index (Only )?Scan( Backward)? using audit_events_chain_seq on audit_events/);
    expect(listing).toMatch(/Index Scan using audit_events_at on audit_events/);
    for (const plan of plans) {
      expect(plan).toMatch(/Index Cond: \(\(?tenant_id = /);
      expect(plan).not.toMatch(/Seq Scan/);
    }
  });

  it('is applied once: a second migrate applies nothing, and the owner still migrates and grants', async () => {
    expect((await migrate(db.owner, await allMigrations(BUILTIN_MODULES))).applied).toEqual([]);
    await db.grant();
    expect(await rowSecurityOf(db.owner)).toEqual(await rowSecurityOf(db.owner));
  });
});
