/**
 * `admin tenancy revert` (hosted edition spec §19.10, plan Task 28) on the frozen 0019 fixture: fixture → migrate →
 * the forward steps → revert matches the fixture through the migration test's catalog readers, with its rows, its
 * layout and every blob open under the old derivation, including blobs a real host wrote after `done`; a kill in each
 * of the three states resumes, and a forward start-up in any of them refuses; and the refusals.
 */
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createRestRequest, entry, type SyncPushResponse } from '@wirebench/engine';
import { migrate } from '../../../src/db/migrate.js';
import { openSession } from '../../../src/db/pool.js';
import { open, seal } from '../../../src/hooks/secret-box.js';
import { userSecretsKey } from '../../../src/host/server-platform.js';
import { insertToken } from '../../../src/identity/repo.js';
import { mintToken, newId } from '../../../src/identity/tokens.js';
import { main } from '../../../src/main.js';
import { BUILTIN_MODULES } from '../../../src/modules.js';
import { allMigrations, StartupError, startServer } from '../../../src/serve.js';
import { readTenancyStep, runTenancySteps, type TenancyStep } from '../../../src/tenancy/file-step.js';
import { RunningLock, SERVER_DRAIN_MS } from '../../../src/tenancy/running-lock.js';
import { REVERT_WAIT_MS, revertTenancy, serverSessions, type RevertOptions } from '../../../src/tenancy/revert.js';
import { loadFixture0019, type Fixture0019 } from '../../fixtures/tenancy/load.js';
import {
  columnsOf,
  indexesOf,
  keysOf,
  otherConstraintsOf,
  policiesOf,
  routinesOf,
  rowSecurityOf,
  tablesOf,
} from '../../helpers/catalog.js';
import { describeDb, testDatabase, type TestDatabase } from '../../helpers/database.js';
import { mkTempDir, removeTempDir } from '../../helpers/git.js';
import { browserUser, hostHarness, openHost, PUBLIC_URL, storedCookie } from '../../helpers/host.js';
import type { SignedInUser } from '../../helpers/identity.js';
import { freePort } from '../../helpers/net.js';
import { workspaceSnapshot } from '../../helpers/schedule-runs.js';
import { seedSyncWorkspace } from '../../helpers/sync.js';
import { call, seedTeam } from '../../helpers/teams.js';

interface SecretsFile {
  entries: Record<string, { value: string; encrypted: boolean; label?: string }>;
}

/** The catalog as the migration test reads it, and what else the revert must leave as 0019 had it. */
async function catalog(db: TestDatabase['owner']) {
  return {
    tables: await tablesOf(db),
    columns: await columnsOf(db),
    keys: await keysOf(db),
    indexes: await indexesOf(db),
    checks: await otherConstraintsOf(db),
    routines: await routinesOf(db),
    policies: await policiesOf(db),
    rowSecurity: await rowSecurityOf(db),
  };
}

/** Every row of every table, as canonical JSON, sorted: the rows compare whatever their physical order. */
async function rowsOf(db: TestDatabase['owner'], tables: readonly string[]): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const table of tables) {
    const rows = await db.query<{ r: string }>(`select to_jsonb(x)::text as r from ${table} x`);
    out[table] = rows.rows.map((row) => row.r).sort();
  }
  return out;
}

/** Every path under `dir`, `/`-separated, a directory with a trailing `/`; git objects left out. */
async function layoutOf(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (at: string): Promise<void> => {
    for (const name of (await readdir(at)).sort()) {
      const path = join(at, name);
      const rel = relative(dir, path).split(sep).join('/');
      if ((await lstat(path)).isDirectory()) {
        out.push(`${rel}/`);
        if (name !== 'objects') await walk(path);
      } else out.push(rel);
    }
  };
  await walk(dir);
  return out;
}

const tryOpen = (key: Buffer, blob: string): string | undefined => {
  try {
    return open(key, Buffer.from(blob, 'base64'));
  } catch {
    return undefined;
  }
};

/** Every blob of one user's checkout, opened under `key`: secrets by entry id, jars by file name. */
async function blobsOf(checkout: string, key: Buffer): Promise<Record<string, string | undefined>> {
  const out: Record<string, string | undefined> = {};
  if (existsSync(join(checkout, 'secrets.json'))) {
    const file = JSON.parse(await readFile(join(checkout, 'secrets.json'), 'utf8')) as SecretsFile;
    for (const [id, one] of Object.entries(file.entries))
      if (one.encrypted) out[`secret ${id}`] = tryOpen(key, one.value);
  }
  const jars = join(checkout, 'cookie-jars');
  if (existsSync(jars)) {
    for (const name of (await readdir(jars)).sort()) {
      const jar = JSON.parse(await readFile(join(jars, name), 'utf8')) as { data: string };
      out[`jar ${name}`] = tryOpen(key, jar.data);
    }
  }
  return out;
}

/** The sealed audit rows as stored: their bytes and their physical row, which no revert may rewrite. */
const SEALED = `select id, chain_seq::text as seq, encode(chain_hash, 'hex') as hash, ctid::text as ctid, xmin::text as xmin
  from audit_events where chain_seq is not null order by chain_seq`;

describeDb('admin tenancy revert on the frozen 0019 fixture (spec §19.10, plan Task 28)', () => {
  let db: TestDatabase;
  let dataDir: string;
  let fixture: Fixture0019;
  let root: Buffer;
  let tenantId: string;
  let before: Awaited<ReturnType<typeof catalog>>;
  let rowsBefore: Record<string, string[]>;
  let layoutBefore: string[];
  let sealedBefore: unknown[];
  /** Alice's blobs as slice 2 sealed them, opened under the old per-user key. */
  let aliceBefore: Record<string, string | undefined>;

  const alice = () => fixture.users.alice;
  const oldCheckout = () => join(dataDir, fixture.checkout);
  const newCheckout = () => join(dataDir, 'tenants', tenantId, fixture.checkout);
  const step = async (): Promise<TenancyStep | undefined> => (await readTenancyStep(db.owner))?.step;

  beforeEach(async () => {
    db = await testDatabase({ migrated: false });
    dataDir = await mkTempDir('wbs-revert-');
    fixture = await loadFixture0019(db.owner, dataDir);
    root = Buffer.from(fixture.keys.secretsKey, 'base64');
    before = await catalog(db.owner);
    rowsBefore = await rowsOf(db.owner, before.tables);
    layoutBefore = await layoutOf(dataDir);
    sealedBefore = (await db.owner.query(SEALED)).rows;
    aliceBefore = await blobsOf(oldCheckout(), userSecretsKey(root, alice()));
    // The upgrade, to the end: both migrations, the move, the data key and the re-wrap.
    await db.migrate(await allMigrations(BUILTIN_MODULES));
    tenantId = (await readTenancyStep(db.owner))!.defaultTenantId;
    expect(await runTenancySteps(db.owner, dataDir, { root })).toBe('done');
  });
  afterEach(async () => {
    await db.close();
    await removeTempDir(dataDir);
  });

  /**
   * The revert with no wait and no other server; `options` changes either. A key given as `undefined` is left out:
   * `waitMs` for the real wait, `root` for none.
   */
  const revert = (options: { [K in keyof RevertOptions]?: RevertOptions[K] | undefined } = {}) => {
    const given = Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined));
    const base: RevertOptions = {
      url: db.ownerUrl,
      dataDir,
      root,
      waitMs: 0,
      serverSessions: () => Promise.resolve([]),
    };
    const merged = { ...base, ...given } as RevertOptions & Record<string, unknown>;
    for (const [key, value] of Object.entries(options)) if (value === undefined) delete merged[key];
    return revertTenancy(merged);
  };

  /** What a reverted fixture must be: 0019's catalog, rows and layout, and every blob under the old key. */
  async function expectReverted(): Promise<void> {
    expect(await catalog(db.owner)).toEqual(before);
    expect(await rowsOf(db.owner, before.tables)).toEqual(rowsBefore);
    expect((await db.owner.query(SEALED)).rows).toEqual(sealedBefore);
    const ledger = await db.owner.query<{ v: number }>('select version as v from schema_migrations order by 1');
    expect(ledger.rows.map((row) => row.v)).toEqual(Array.from({ length: 19 }, (_, i) => i + 1));
    // The old layout: the move's scratch is gone (the forward step deleted it), the rest is where 0019 had it.
    expect(await layoutOf(dataDir)).toEqual(layoutBefore.filter((path) => path !== 'tmp/scratch-0019.txt'));
    expect(await blobsOf(oldCheckout(), userSecretsKey(root, alice()))).toEqual(aliceBefore);
    expect(Object.values(aliceBefore).every((plain) => plain !== undefined)).toBe(true);
    expect(Object.values(aliceBefore)).toContain(fixture.plaintexts.hostSecret);
  }

  /** `main` with the fixture's database and this data directory, two roles and the root. */
  const env = () => ({
    WIREBENCH_SERVER_MIGRATION_DATABASE_URL: db.ownerUrl,
    WIREBENCH_SERVER_DATABASE_URL: db.url,
    WIREBENCH_SERVER_PUBLIC_URL: 'https://wirebench.test',
    WIREBENCH_SERVER_DATA_DIR: dataDir,
    WIREBENCH_SERVER_SECRETS_KEY: fixture.keys.secretsKey,
    WIREBENCH_SERVER_LOG_LEVEL: 'fatal',
  });
  const cli = async (args: string[], seams: Parameters<typeof main>[3] = {}) => {
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const code = await main(args, { stdout, stderr, env: env() }, {}, seams);
    const text = (mock: typeof stdout) => mock.write.mock.calls.map((c) => String(c[0])).join('');
    return { code, out: text(stdout), err: text(stderr) };
  };
  const start = async () => {
    const withPort = { ...env(), WIREBENCH_SERVER_HOST: '127.0.0.1', WIREBENCH_SERVER_PORT: String(await freePort()) };
    return startServer(
      withPort,
      { stdout: { write: vi.fn() }, stderr: { write: vi.fn() }, env: withPort },
      { signals: new EventEmitter(), exit: vi.fn(), modules: BUILTIN_MODULES },
    );
  };

  /** Every forward path refuses while a revert is not finished, and changes nothing. */
  async function expectForwardRefused(at: TenancyStep): Promise<void> {
    await expect(runTenancySteps(db.owner, dataDir, { root })).rejects.toMatchObject({ code: 'tenancy-reverting' });
    const migrated = await cli(['migrate']);
    expect(migrated.code).toBe(2);
    expect(migrated.err).toContain('tenancy-reverting');
    const checked = await cli(['migrate', '--check']);
    expect(checked.code).toBe(1);
    expect(checked.err).toContain('tenancy-reverting');
    const error = await start().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StartupError);
    expect((error as StartupError).exitCode).toBe(2);
    expect((error as Error).message).toContain('tenancy-reverting');
    expect(await step()).toBe(at);
  }

  it('the round trip: fixture, migrate, revert gives back the 0019 catalog, rows, layout and blobs', async () => {
    const lines: string[] = [];
    const result = await revert({ report: (line) => lines.push(line) });
    expect(result.outcome).toBe('reverted');
    // Every blob of slice 2 (Alice's secrets and her two jars) was re-wrapped forward; back re-seals them all.
    expect(result.counts).toMatchObject({ resealed: Object.keys(aliceBefore).length, already: 0, unopened: 0 });
    expect(lines.join('\n')).toContain(
      `re-wrap back: ${String(Object.keys(aliceBefore).length)} re-sealed under the old key`,
    );
    await expectReverted();
    expect(before.policies).toEqual([]);
    expect(before.rowSecurity.every((table) => !table.enabled && !table.forced)).toBe(true);
    expect(before.tables).not.toContain('tenants');
    expect(before.tables).not.toContain('host_leases');
    expect(before.routines).toEqual([]);
    // The 0019 runner's view: its migrations are every one applied, and nothing is newer.
    const at0019 = (await allMigrations(BUILTIN_MODULES)).filter((m) => m.version <= 19);
    expect((await migrate(db.owner, at0019)).applied).toEqual([]);
    // A second run has nothing to do.
    expect((await revert()).outcome).toBe('nothing');
  });

  it('after a revert, the upgrade runs again from files, with a new tenant and a new data key (carried note 7)', async () => {
    expect((await revert()).outcome).toBe('reverted');
    await db.migrate(await allMigrations(BUILTIN_MODULES));
    const again = await readTenancyStep(db.owner);
    expect(again?.step).toBe('files');
    expect(again?.defaultTenantId).not.toBe(tenantId);
    tenantId = again!.defaultTenantId;
    expect(await runTenancySteps(db.owner, dataDir, { root })).toBe('done');
    expect(existsSync(newCheckout())).toBe(true);
    // The old key opens nothing now: every blob is under the new data key.
    expect(
      Object.values(await blobsOf(newCheckout(), userSecretsKey(root, alice()))).every((p) => p === undefined),
    ).toBe(true);
    // And a second revert brings back the fixture again.
    expect((await revert()).outcome).toBe('reverted');
    await expectReverted();
  });

  it('waits the stop window and the drain, holding the lock, before it reads the server sessions', async () => {
    expect(REVERT_WAIT_MS).toBe((20 + 150) * 1000 + SERVER_DRAIN_MS);
    expect(REVERT_WAIT_MS).toBeGreaterThanOrEqual(180_000);
    const order: string[] = [];
    await revert({
      waitMs: undefined,
      sleep: async (ms) => {
        order.push(`sleep ${String(ms)}`);
        // While the revert waits, its exclusive lock refuses a server's start.
        const error = await start().catch((caught: unknown) => caught);
        expect((error as Error).message).toContain('tenancy-reverting');
      },
      serverSessions: () => {
        order.push('sessions');
        return Promise.resolve([]);
      },
    });
    expect(order).toEqual([`sleep ${String(REVERT_WAIT_MS)}`, 'sessions']);
    await expectReverted();
  });

  it('the old derivation opens blobs a real host wrote after done: a new user, a new secret, a new jar', async () => {
    const h = await hostHarness({ db, dataDir, env: { WIREBENCH_SERVER_SECRETS_KEY: fixture.keys.secretsKey } });
    let bob: SignedInUser;
    try {
      bob = await browserUser(h, 'revert-bob@example.test');
      // Alice, a fixture user, signs in to the browser too.
      const { token, hash } = mintToken();
      await insertToken(h.tdb, {
        id: newId(),
        userId: alice(),
        tokenHash: hash,
        deviceName: 'browser',
        kind: 'browser',
        at: h.clock.now,
      });
      const aliceHost = await openHost(h, { token } as SignedInUser);
      await aliceHost.waitFor((frame) => frame.type === 'hello');
      expect(await aliceHost.call('secrets.set', { value: 'after-done-alice-0123', label: 'a' })).toMatchObject({
        ok: true,
      });
      aliceHost.close();
      // Bob: a workspace of his own, joined, a secret and a cookie.
      const team = await seedTeam(h, { name: 'Revert', admins: [bob] });
      const workspaceId = await seedSyncWorkspace(h, { team, name: 'Revert' });
      const requests = [
        {
          ...createRestRequest('Health', { id: 'req-health', url: 'https://revert.test/ok' }),
          headers: [entry('X-Key', '${secret:API_KEY}')],
        },
      ];
      const changes = (await workspaceSnapshot(requests)).map((file) =>
        file.path === 'workspace.yaml'
          ? {
              path: file.path,
              encoding: 'utf8' as const,
              content: Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8')
                .toString('utf8')
                .replace('workspace-smoke', workspaceId),
            }
          : file,
      );
      const pushed = await call<SyncPushResponse>(h, bob, 'POST', `/workspaces/${workspaceId}/sync/commits`, {
        parent: null,
        commits: [{ subject: 'Start', at: '2026-09-24T12:00:00.000Z', changes }],
      });
      expect(pushed.status).toBe(201);
      const bobHost = await openHost(h, bob);
      await bobHost.waitFor((frame) => frame.type === 'hello');
      expect(await bobHost.call('secrets.set', { value: 'after-done-bob-0123', label: 'b' })).toMatchObject({
        ok: true,
      });
      expect(await bobHost.call('workspace.joinFromServer', { url: PUBLIC_URL, workspaceId })).toMatchObject({
        ok: true,
      });
      // The join switches to the workspace's own jar a moment later; until then the jar is session-only.
      await vi.waitFor(
        async () => {
          expect(await bobHost.call('cookies.list')).toMatchObject({ ok: true, value: { persisted: true } });
        },
        { timeout: 10_000 },
      );
      expect(
        await bobHost.call('cookies.set', { cookie: storedCookie('session', 'after-done-cookie', 'revert.test') }),
      ).toMatchObject({ ok: true, value: { persisted: true } });
      const bobJar = join(dataDir, 'tenants', tenantId, 'checkouts', bob.user.id, 'cookie-jars', `${workspaceId}.json`);
      // The host's cookie store writes a second after the change (its debounce).
      await vi.waitFor(
        () => {
          expect(existsSync(bobJar)).toBe(true);
        },
        { timeout: 10_000 },
      );
      bobHost.close();
    } finally {
      await h.close();
    }
    // The fixture's database still holds what the host wrote; the revert goes back from there.
    expect((await revert()).outcome).toBe('reverted');
    const oldKey = (user: string) => userSecretsKey(root, user);
    const aliceAfter = await blobsOf(oldCheckout(), oldKey(alice()));
    expect(Object.values(aliceAfter).every((plain) => plain !== undefined)).toBe(true);
    expect(Object.values(aliceAfter)).toEqual(
      expect.arrayContaining([fixture.plaintexts.hostSecret, 'after-done-alice-0123']),
    );
    const bobAfter = await blobsOf(join(dataDir, 'checkouts', bob.user.id), oldKey(bob.user.id));
    expect(Object.values(bobAfter)).toHaveLength(2);
    expect(Object.values(bobAfter)).toContain('after-done-bob-0123');
    expect(Object.values(bobAfter).find((plain) => plain?.includes('after-done-cookie'))).toBeDefined();
    // The catalog is 0019's, whatever rows the host added.
    const after = await catalog(db.owner);
    expect(after).toEqual(before);
  });

  /** Where a kill stops the revert, and the step it leaves. */
  const kills: readonly (readonly [string, TenancyStep])[] = [
    ['recorded reverting-keys', 'reverting-keys'],
    ['re-wrapped a file back', 'reverting-keys'],
    ['recorded reverting-files', 'reverting-files'],
    ['moved back repos', 'reverting-files'],
    ['removed the tenant tmp', 'reverting-files'],
    ['recorded reverting-rows', 'reverting-rows'],
    ['rows reverted, not committed', 'reverting-rows'],
  ];
  for (const [part, at] of kills) {
    it(`a kill at "${part}" leaves ${at}: a forward start-up refuses, and the next run finishes`, async () => {
      const killed = new Error('killed');
      await expect(
        revert({
          checkpoint: (reached) => {
            if (reached === part) throw killed;
          },
        }),
      ).rejects.toBe(killed);
      expect(await step()).toBe(at);
      await expectForwardRefused(at);
      const resumed = await revert();
      expect(resumed.outcome).toBe('reverted');
      // Nothing is sealed twice: what the killed run re-sealed is already under the old key.
      if (part === 're-wrapped a file back') {
        expect(resumed.counts?.already).toBeGreaterThan(0);
        expect((resumed.counts?.already ?? 0) + (resumed.counts?.resealed ?? 0)).toBe(Object.keys(aliceBefore).length);
      }
      await expectReverted();
    });
  }

  it('the command line runs it, prints counts and no tenant, and a second run has nothing to do', async () => {
    const seams = { waitMs: 0, serverSessions: () => Promise.resolve([]) };
    const first = await cli(['admin', 'tenancy', 'revert'], seams);
    expect(first.err).toBe('');
    expect(first.code).toBe(0);
    expect(first.out).toContain(`re-wrap back: ${String(Object.keys(aliceBefore).length)} re-sealed under the old key`);
    expect(first.out).toContain('reverted: the previous version of the server can now start');
    expect(first.out).not.toContain(tenantId);
    expect(first.out).not.toContain('default');
    await expectReverted();
    const second = await cli(['admin', 'tenancy', 'revert'], seams);
    expect(second.code).toBe(0);
    expect(second.out).toContain('nothing to revert');
  });

  it('refuses a second tenant, changing nothing', async () => {
    await db.owner.query("insert into tenants (id, slug, name) values (gen_random_uuid(), 'second', 'Second')");
    await expect(revert()).rejects.toMatchObject({ code: 'tenancy-revert-tenants' });
    expect(await step()).toBe('done');
    expect(existsSync(newCheckout())).toBe(true);
  });

  it('refuses a migration newer than 0021, changing nothing', async () => {
    await db.owner.query("insert into schema_migrations (version, name) values (22, 'later')");
    await expect(revert()).rejects.toMatchObject({ code: 'tenancy-revert-too-new' });
    expect(await step()).toBe('done');
    expect(existsSync(newCheckout())).toBe(true);
  });

  it('refuses while a server holds the running lock, changing nothing', async () => {
    const lock = await RunningLock.acquire(db.ownerUrl, { onLost: () => undefined });
    try {
      const sleep = vi.fn(() => Promise.resolve());
      await expect(revert({ sleep })).rejects.toMatchObject({ code: 'tenancy-revert-server-running' });
      expect(sleep).not.toHaveBeenCalled();
    } finally {
      await lock.release();
    }
    expect(await step()).toBe('done');
    expect(existsSync(newCheckout())).toBe(true);
  });

  it('refuses a server connection still open after the wait, changing nothing', async () => {
    const error = await revert({
      serverSessions: () => Promise.resolve([{ pid: 4242, name: 'wirebench-server' }]),
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'tenancy-revert-server-running' });
    expect((error as Error).message).toContain('4242');
    expect(await step()).toBe('done');
  });

  it("server sessions are the server's pool and lock, never the command line's, a bare session's or its own", async () => {
    const names = [
      'wirebench-server',
      'wirebench-server-lock',
      'wirebench-admin',
      'wirebench-migrate',
      'wirebench-session',
    ];
    const sessions = await Promise.all(names.map((applicationName) => openSession(db.url, { applicationName })));
    try {
      const pids = new Map(sessions.map((session, i) => [session.pid, names[i]!]));
      const seen = (await serverSessions(sessions[0]!)).filter((one) => pids.has(one.pid));
      expect(seen.map((one) => one.name)).toEqual(['wirebench-server-lock']);
      const fromAdmin = (await serverSessions(sessions[2]!)).filter((one) => pids.has(one.pid));
      expect(fromAdmin.map((one) => one.name).sort()).toEqual(['wirebench-server', 'wirebench-server-lock']);
    } finally {
      await Promise.all(sessions.map((session) => session.close()));
    }
  });

  it('a blob that opens under neither key stops it at reverting-keys until told to go on, and keeps its bytes', async () => {
    const secrets = join(newCheckout(), 'secrets.json');
    const file = JSON.parse(await readFile(secrets, 'utf8')) as SecretsFile;
    const foreign = seal(randomBytes(32), 'nobody-can-open-this').toString('base64');
    file.entries['sec_foreign0000000000000000'] = { value: foreign, encrypted: true, label: 'foreign' };
    await writeFile(secrets, JSON.stringify(file));
    const lines: string[] = [];
    await expect(revert({ report: (line) => lines.push(line) })).rejects.toMatchObject({
      code: 'tenancy-revert-unopened',
    });
    expect(lines.join('\n')).toContain('1 opened under neither key');
    expect(await step()).toBe('reverting-keys');
    await expectForwardRefused('reverting-keys');
    // The command line says so too, and exits 2.
    const refused = await cli(['admin', 'tenancy', 'revert'], { waitMs: 0, serverSessions: () => Promise.resolve([]) });
    expect(refused.code).toBe(2);
    expect(refused.err).toContain('tenancy-revert-unopened');
    expect(refused.err).toContain('--accept-unopened');
    const accepted = await cli(['admin', 'tenancy', 'revert', '--accept-unopened'], {
      waitMs: 0,
      serverSessions: () => Promise.resolve([]),
    });
    expect(accepted.code).toBe(0);
    const after = JSON.parse(await readFile(join(oldCheckout(), 'secrets.json'), 'utf8')) as SecretsFile;
    expect(after.entries['sec_foreign0000000000000000']?.value).toBe(foreign);
    expect(await catalog(db.owner)).toEqual(before);
  });

  it('refuses without the root while a data key exists, changing nothing', async () => {
    await expect(revert({ root: undefined })).rejects.toMatchObject({ code: 'tenancy-no-root' });
    expect(await step()).toBe('done');
    expect(existsSync(newCheckout())).toBe(true);
  });

  it('refuses a data directory that is not the server’s, changing nothing', async () => {
    const empty = await mkTempDir('wbs-revert-empty-');
    try {
      await expect(revert({ dataDir: empty })).rejects.toMatchObject({ code: 'tenancy-data-dir-empty' });
    } finally {
      await removeTempDir(empty);
    }
    expect(await step()).toBe('done');
  });

  it('refuses a directory in both places, naming both, changing nothing', async () => {
    await mkdir(join(dataDir, 'repos'));
    const error = await revert().catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'tenancy-move-conflict' });
    expect((error as Error).message).toContain(join(dataDir, 'repos'));
    expect(await step()).toBe('done');
  });
});
