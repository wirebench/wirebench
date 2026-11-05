/**
 * Slice 7 Task 23 (hosted edition spec §22.11): the deletion job. Once `deleting_at` has passed, the tenant's rows
 * and directory are gone (checked on the control role, past the policy), its slug is retired with no redirect,
 * `tenant_deletions` holds its chain's last link, and the other tenant is untouched; a crash after any step is
 * resumed by the next pass; a subscription still billed makes it wait, logged once a day.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest';
import { derivedChainKey } from '../../../src/audit-log/chain/keys.js';
import { AuditSealer } from '../../../src/audit-log/chain/sealer.js';
import { auditHook } from '../../../src/audit-log/hook.js';
import { serverHooks } from '../../../src/context.js';
import { openControlDb, type ControlDb } from '../../../src/control-plane/control-db.js';
import { TenantDeletion, type DeletionStep } from '../../../src/control-plane/delete.js';
import { ControlLoop } from '../../../src/control-plane/loop.js';
import { DELETION_DAYS, TenantLifecycle } from '../../../src/control-plane/tenants.js';
import { newId } from '../../../src/identity/tokens.js';
import { environmentKeyRoot } from '../../../src/tenancy/keys.js';
import { tenantRoot } from '../../../src/tenancy/paths.js';
import { ensureControlRole } from '../../../src/tenancy/roles.js';
import type { TenantScope } from '../../../src/tenancy/scope.js';
import { createTenancy, type Tenancy } from '../../../src/tenancy/tenancy.js';
import { SCOPED_TABLES } from '../../helpers/catalog.js';
import { describeDb, testDatabase, type TestDatabase } from '../../helpers/database.js';
import { mkTempDir, removeTempDir } from '../../helpers/git.js';
import { manualTimers } from '../../helpers/timers.js';

/** Each suite's set-up builds servers and repositories: under load that is past the 10 s default. */
const SETUP_MS = 120_000;

const ROOT = Buffer.alloc(32, 9);
const CHAIN = 'test-chain-key-for-the-deletion-suite';
const T0 = new Date('2026-11-04T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

describeDb('the deletion job (spec §22.11)', () => {
  let db: TestDatabase;
  let control: ControlDb;
  let tenancy: Tenancy;
  let lifecycle: TenantLifecycle;
  let dataDir: string;
  let now: Date;
  type LogFn = (...args: unknown[]) => void;
  let log: { info: Mock<LogFn>; warn: Mock<LogFn>; error: Mock<LogFn> };

  beforeEach(async () => {
    db = await testDatabase();
    await ensureControlRole(db.owner, db.controlUrl, db.url);
    control = openControlDb(db.controlUrl);
    tenancy = createTenancy(db, { keyRoot: environmentKeyRoot(ROOT) });
    const hooks = serverHooks();
    hooks.audit.push(auditHook(() => now));
    now = T0;
    lifecycle = new TenantLifecycle({ control, tenancy, hooks, now: () => now });
    dataDir = await mkTempDir('wbs-delete-');
    log = { info: vi.fn<LogFn>(), warn: vi.fn<LogFn>(), error: vi.fn<LogFn>() };
  }, SETUP_MS);
  afterEach(async () => {
    await control.close();
    await db.close();
    await removeTempDir(dataDir);
  }, SETUP_MS);

  /** A tenant with rows in several scoped tables, a sealed chain, a custom name, and files on disk. */
  const team = async (slug: string): Promise<TenantScope> => {
    const made = await lifecycle.create({ slug, name: slug, edition: 'team', editionSource: 'operator' });
    const tdb = tenancy.db(made.scope);
    const userId = newId();
    await tdb.query(
      "insert into users (id, email, email_lower, display_name, server_admin) values ($1, $2, $2, 'Admin', true)",
      [userId, `admin@${slug}.example`],
    );
    const teamId = newId();
    await tdb.query("insert into teams (id, name) values ($1, 'Ops')", [teamId]);
    await tdb.query(
      "insert into workspaces (id, name, team_id, default_role, created_by) values ($1, 'Staging', $2, 'viewer', $3)",
      [newId(), teamId, userId],
    );
    await tdb.query("insert into tenant_settings (section, value, updated_by) values ('mail', '{}', 'operator')");
    await tdb.query("insert into custom_domains (name, token, state) values ($1, 'token', 'active')", [
      `api.${slug}.example`,
    ]);
    await db.owner.query('insert into tenant_hosts (host, tenant_id, live) values ($1, $2::uuid, true)', [
      `api.${slug}.example`,
      made.scope.tenantId,
    ]);
    const sealer = new AuditSealer({
      tenancy,
      keys: (scope) => derivedChainKey(CHAIN, scope.tenantId),
      now: () => now,
      setTimer: manualTimers().setTimer,
      log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as never,
    });
    await sealer.runOnce();
    const root = tenantRoot(dataDir, made.scope);
    await mkdir(join(root, 'repos', 'x.git'), { recursive: true });
    await mkdir(join(root, 'checkouts', userId), { recursive: true });
    await writeFile(join(root, 'checkouts', userId, 'secrets.json'), '{}');
    return made.scope;
  };

  const deletion = (afterStep?: (step: DeletionStep) => void) =>
    new TenantDeletion({
      control,
      db: tenancy.db,
      lifecycle,
      dataDir,
      log,
      ...(afterStep !== undefined ? { afterStep } : {}),
    });
  const pass = (job: TenantDeletion) => new ControlLoop({ control, log, now: () => now, steps: [job.step()] }).pass();

  /** Rows of `tenantId` left in every scoped table, read on the control role. */
  const rowsLeft = async (tenantId: string): Promise<Record<string, number>> => {
    const left: Record<string, number> = {};
    for (const table of SCOPED_TABLES) {
      const n = Number(
        (
          await control.query<{ n: string }>(`select count(*)::text as n from ${table} where tenant_id = $1::uuid`, [
            tenantId,
          ])
        ).rows[0]!.n,
      );
      if (n > 0) left[table] = n;
    }
    return left;
  };

  const due = async (slug: string) => {
    await lifecycle.requestDeletion(slug);
    now = new Date(T0.getTime() + DELETION_DAYS * DAY_MS + 1000);
  };

  it('removes every row, the directory and the tenant, retires the slug and keeps the chain anchor', async () => {
    const acme = await team('acme');
    const beta = await team('beta');
    const anchor = (
      await control.query<{ seq: string; hash: string; key_id: string }>(
        `select chain_seq::text as seq, encode(chain_hash, 'hex') as hash,
                (select key_id from audit_chain_anchor where tenant_id = $1::uuid) as key_id
           from audit_events where tenant_id = $1::uuid and chain_seq is not null order by chain_seq desc limit 1`,
        [acme.tenantId],
      )
    ).rows[0]!;
    const betaRows = await rowsLeft(beta.tenantId);
    // Asked for and not due yet: nothing happens.
    await lifecycle.requestDeletion('acme');
    await pass(deletion());
    expect((await control.query("select status from tenants where slug = 'acme'")).rows).toEqual([
      { status: 'active' },
    ]);
    now = new Date(T0.getTime() + DELETION_DAYS * DAY_MS + 1000);
    await pass(deletion());
    expect(await rowsLeft(acme.tenantId)).toEqual({});
    expect((await control.query('select 1 from tenants where id = $1::uuid', [acme.tenantId])).rows).toEqual([]);
    // Its custom name went with the row (the owner reads it: the control role has no grant on the routing table).
    expect(
      (await db.owner.query('select 1 from tenant_hosts where tenant_id = $1::uuid', [acme.tenantId])).rows,
    ).toEqual([]);
    expect(existsSync(tenantRoot(dataDir, acme))).toBe(false);
    expect(
      (await control.query("select tenant_id::text as id, redirect_to from tenant_slugs_retired where slug = 'acme'"))
        .rows,
    ).toEqual([{ id: acme.tenantId, redirect_to: null }]);
    expect(
      (
        await control.query<{ chain_seq: string; chain_hash: string; chain_key_id: string; slug: string }>(
          'select slug, chain_seq::text as chain_seq, chain_hash, chain_key_id from tenant_deletions where tenant_id = $1::uuid',
          [acme.tenantId],
        )
      ).rows,
    ).toEqual([{ slug: 'acme', chain_seq: anchor.seq, chain_hash: anchor.hash, chain_key_id: anchor.key_id }]);
    // The other tenant is whole.
    expect(await rowsLeft(beta.tenantId)).toEqual(betaRows);
    expect(existsSync(tenantRoot(dataDir, beta))).toBe(true);
    // A retired slug is never written again.
    await expect(
      lifecycle.create({ slug: 'acme', name: 'acme', edition: 'team', editionSource: 'operator' }),
    ).rejects.toMatchObject({
      code: 'control-plane-slug-taken',
    });
  });

  it.each(['deleting', 'rows', 'files', 'check', 'removed'] as const)(
    'resumes after a crash after the %s step',
    async (crashAt) => {
      const acme = await team('acme');
      await due('acme');
      let crashed = false;
      await pass(
        deletion((step) => {
          if (step === crashAt && !crashed) {
            crashed = true;
            throw new Error(`crash after ${step}`);
          }
        }),
      );
      expect(crashed).toBe(true);
      await pass(deletion());
      expect(await rowsLeft(acme.tenantId)).toEqual({});
      expect((await control.query('select 1 from tenants where id = $1::uuid', [acme.tenantId])).rows).toEqual([]);
      expect(existsSync(tenantRoot(dataDir, acme))).toBe(false);
      expect(
        (await control.query('select 1 from tenant_deletions where tenant_id = $1::uuid', [acme.tenantId])).rows,
      ).toHaveLength(1);
    },
  );

  it('waits while the subscription is billed, saying so once a day', async () => {
    const acme = await team('acme');
    await tenancy
      .db(acme)
      .query(
        "insert into subscriptions (provider, provider_ref, plan, seats, status, last_event_at) values ('paddle', 'sub_test_del', 'team', 3, 'active', now())",
      );
    await due('acme');
    await pass(deletion());
    await pass(deletion());
    expect((await control.query("select status from tenants where slug = 'acme'")).rows).toEqual([
      { status: 'active' },
    ]);
    const waits = log.warn.mock.calls.filter(
      ([details]) => (details as { code?: string }).code === 'deletion-subscription-active',
    );
    expect(waits).toHaveLength(1);
    now = new Date(now.getTime() + DAY_MS);
    await pass(deletion());
    expect(
      log.warn.mock.calls.filter(([details]) => (details as { code?: string }).code === 'deletion-subscription-active'),
    ).toHaveLength(2);
    // Canceled at the provider: the deletion goes on.
    await tenancy.db(acme).query("update subscriptions set status = 'canceled'");
    await pass(deletion());
    expect((await control.query('select 1 from tenants where id = $1::uuid', [acme.tenantId])).rows).toEqual([]);
  });
});
