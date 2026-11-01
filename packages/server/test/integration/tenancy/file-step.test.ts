/**
 * The file step of the self-hosted migration (hosted edition spec §19.10): the frozen fixture's data directory
 * moves under the default tenant, `removed-…` survives, scratch goes, a kill after each part resumes, a conflict
 * refuses before anything moves, and a state file naming the old prefix refuses, naming it.
 */
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { main } from '../../../src/main.js';
import { BUILTIN_MODULES } from '../../../src/modules.js';
import { startServer, StartupError } from '../../../src/serve.js';
import { moveFiles, readTenancyStep, runTenancySteps } from '../../../src/tenancy/file-step.js';
import { loadFixture0019, type Fixture0019 } from '../../fixtures/tenancy/load.js';
import { describeDb, testDatabase } from '../../helpers/database.js';
import { mkTempDir, removeTempDir } from '../../helpers/git.js';
import { freePort } from '../../helpers/net.js';

const USER = '01JB3Z9K7Q4ZJ6X1V8W2M5N0PA';
/** `WIREBENCH_SERVER_SECRETS_KEY`: with it the step goes on through `keys` to `done` (Task 24). */
const withRoot = { root: Buffer.alloc(32, 0x52) };
const WS = '01J8ZC5Q0V7R3T9XK2M4N6P8QA';

/** Every path under `dir`, `/`-separated and sorted. */
async function tree(dir: string): Promise<string[]> {
  return (await readdir(dir, { recursive: true })).map((p) => p.split('\\').join('/')).sort();
}

/** A small data directory in the layout before §19.6: a repository, a checkout, a kept repository and scratch. */
async function oldLayout(dataDir: string): Promise<void> {
  await mkdir(join(dataDir, 'repos', `${WS}.git`), { recursive: true });
  await writeFile(join(dataDir, 'repos', `${WS}.git`, 'HEAD'), 'ref: refs/heads/main\n');
  await mkdir(join(dataDir, 'checkouts', USER, 'workspaces', WS, 'tree'), { recursive: true });
  await writeFile(join(dataDir, 'checkouts', USER, 'workspace-state.json'), '{"version":1}\n');
  await mkdir(join(dataDir, 'tmp', `removed-${WS}-1`), { recursive: true });
  await writeFile(join(dataDir, 'tmp', `removed-${WS}-1`, 'HEAD'), 'ref: refs/heads/main\n');
  await mkdir(join(dataDir, 'tmp', `creating-${WS}-ab12`), { recursive: true });
  await mkdir(join(dataDir, 'tmp', 'schedules', 'run-1'), { recursive: true });
  await mkdir(join(dataDir, 'tmp', USER), { recursive: true });
  await writeFile(join(dataDir, 'tmp', `${WS}-0badc0de.idx`), 'x');
  await mkdir(join(dataDir, 'no-hooks'), { recursive: true });
}

/** The same directory after the step, under tenant `t`. */
const movedLayout = (t: string): string[] =>
  [
    'no-hooks',
    'tenants',
    `tenants/${t}`,
    `tenants/${t}/checkouts`,
    `tenants/${t}/checkouts/${USER}`,
    `tenants/${t}/checkouts/${USER}/workspace-state.json`,
    `tenants/${t}/checkouts/${USER}/workspaces`,
    `tenants/${t}/checkouts/${USER}/workspaces/${WS}`,
    `tenants/${t}/checkouts/${USER}/workspaces/${WS}/tree`,
    `tenants/${t}/repos`,
    `tenants/${t}/repos/${WS}.git`,
    `tenants/${t}/repos/${WS}.git/HEAD`,
    `tenants/${t}/tmp`,
    `tenants/${t}/tmp/removed-${WS}-1`,
    `tenants/${t}/tmp/removed-${WS}-1/HEAD`,
  ].sort();

describeDb('the file step (spec §19.10)', () => {
  let db: Awaited<ReturnType<typeof testDatabase>>;
  let dataDir: string;
  beforeEach(async () => {
    db = await testDatabase();
    dataDir = await mkTempDir('wbs-file-step-');
  });
  afterEach(async () => {
    await db.close();
    await removeTempDir(dataDir);
  });

  const tenantId = async (): Promise<string> => (await readTenancyStep(db.owner))!.defaultTenantId;

  it('moves repos/ and checkouts/ under the default tenant, keeps removed-…, deletes the scratch, then is done', async () => {
    await oldLayout(dataDir);
    expect((await readTenancyStep(db.owner))?.step).toBe('files');
    expect(await runTenancySteps(db.owner, dataDir, withRoot)).toBe('done');
    expect(await tree(dataDir)).toEqual(movedLayout(await tenantId()));
    expect((await readTenancyStep(db.owner))?.step).toBe('done');
    // Done is done: a second run moves nothing and reads nothing it would refuse.
    expect(await runTenancySteps(db.owner, dataDir, withRoot)).toBe('done');
  });

  it('runs on a fresh data directory, with nothing to move', async () => {
    expect(await runTenancySteps(db.owner, dataDir, withRoot)).toBe('done');
    expect(await tree(dataDir)).toEqual(['tenants', `tenants/${await tenantId()}`]);
  });

  it('handles an old tmp/ alone, with no repos/ or checkouts/ beside it', async () => {
    await mkdir(join(dataDir, 'tmp', `removed-${WS}-1`), { recursive: true });
    await mkdir(join(dataDir, 'tmp', USER), { recursive: true });
    expect(await runTenancySteps(db.owner, dataDir, withRoot)).toBe('done');
    const t = await tenantId();
    expect(await tree(dataDir)).toEqual(
      ['tenants', `tenants/${t}`, `tenants/${t}/tmp`, `tenants/${t}/tmp/removed-${WS}-1`].sort(),
    );
  });

  it('migrate leaves the move to the next start when the data directory is not there', async () => {
    const missing = join(dataDir, 'not-mounted');
    const stdout = { write: vi.fn() };
    const env = {
      WIREBENCH_SERVER_MIGRATION_DATABASE_URL: db.ownerUrl,
      WIREBENCH_SERVER_DATABASE_URL: db.url,
      WIREBENCH_SERVER_PUBLIC_URL: 'https://wirebench.test',
      WIREBENCH_SERVER_DATA_DIR: missing,
    };
    expect(await main(['migrate'], { stdout, stderr: { write: vi.fn() }, env })).toBe(0);
    expect(stdout.write.mock.calls.map((c) => String(c[0])).join('')).toContain(
      `data directory: ${missing} not found here; the server moves it at its next start`,
    );
    expect(existsSync(missing)).toBe(false);
    expect((await readTenancyStep(db.owner))?.step).toBe('files');
  });

  it('resumes after a kill at every part of the step', async () => {
    const parts = ['renamed repos', 'renamed checkouts', `kept removed-${WS}-1`, 'removed tmp'];
    for (const part of parts) {
      const dir = await mkTempDir('wbs-file-step-kill-');
      const fresh = await testDatabase();
      try {
        await oldLayout(dir);
        const killed = runTenancySteps(fresh.owner, dir, {
          ...withRoot,
          checkpoint: (at) => {
            if (at === part) throw new Error(`killed after ${at}`);
          },
        });
        await expect(killed, part).rejects.toThrow(`killed after ${part}`);
        // The step's row is rolled back with its unit: the next start finishes the job.
        expect((await readTenancyStep(fresh.owner))?.step, part).toBe('files');
        expect(await runTenancySteps(fresh.owner, dir, withRoot), part).toBe('done');
        expect(await tree(dir), part).toEqual(movedLayout((await readTenancyStep(fresh.owner))!.defaultTenantId));
      } finally {
        await fresh.close();
        await removeTempDir(dir);
      }
    }
  });

  it('resumes a re-armed move, from done, after a kill at every part, keeping removed-… (round 2 review I1)', async () => {
    const parts = ['renamed repos', 'renamed checkouts', `kept removed-${WS}-1`, 'removed tmp'];
    for (const part of parts) {
      const dir = await mkTempDir('wbs-file-step-rearm-kill-');
      const fresh = await testDatabase();
      try {
        await oldLayout(dir);
        // A move recorded against another directory: this one is still in the old layout.
        await fresh.owner.query("update server_identity set tenancy_step = 'done'");
        const rearmed: (readonly string[])[] = [];
        const killed = runTenancySteps(fresh.owner, dir, {
          ...withRoot,
          onRearmed: (left) => rearmed.push(left),
          checkpoint: (at) => {
            if (at === part) throw new Error(`killed after ${at}`);
          },
        });
        await expect(killed, part).rejects.toThrow(`killed after ${part}`);
        expect(rearmed, part).toEqual([['repos/', 'checkouts/', 'tmp/']]);
        // The re-arm rolls back with the unit: the step is done again, with part of the tree moved.
        expect((await readTenancyStep(fresh.owner))?.step, part).toBe('done');
        const again: (readonly string[])[] = [];
        expect(
          await runTenancySteps(fresh.owner, dir, { ...withRoot, onRearmed: (left) => again.push(left) }),
          part,
        ).toBe('done');
        expect(await tree(dir), part).toEqual(movedLayout((await readTenancyStep(fresh.owner))!.defaultTenantId));
        // Whatever the kill left at the root re-arms the next run; a kill after the last part leaves nothing.
        expect(again.length, part).toBe(part === 'removed tmp' ? 0 : 1);
      } finally {
        await fresh.close();
        await removeTempDir(dir);
      }
    }
  });

  it('refuses when both the old and the new location exist, naming both, and moves nothing', async () => {
    await oldLayout(dataDir);
    const t = await tenantId();
    await mkdir(join(dataDir, 'tenants', t, 'repos'), { recursive: true });
    const before = await tree(dataDir);
    const error = await runTenancySteps(db.owner, dataDir, withRoot).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'tenancy-move-conflict' });
    expect((error as Error).message).toContain(join(dataDir, 'repos'));
    expect((error as Error).message).toContain(join(dataDir, 'tenants', t, 'repos'));
    expect(await tree(dataDir)).toEqual(before);
    expect((await readTenancyStep(db.owner))?.step).toBe('files');
  });

  it('refuses a state file that names the old checkouts prefix before anything moves, naming the file', async () => {
    await oldLayout(dataDir);
    // A linked project's path is in the workspace manifest.
    await writeFile(
      join(dataDir, 'checkouts', USER, 'workspaces', WS, 'tree', 'workspace.yaml'),
      `projects:\n  - source: linked\n    path: ${join(dataDir, 'checkouts', USER, 'elsewhere')}\n`,
    );
    // A workspace's other files and the history hold any text: they are the user's, and not read.
    await writeFile(
      join(dataDir, 'checkouts', USER, 'workspaces', WS, 'tree', 'notes.txt'),
      join(dataDir, 'checkouts'),
    );
    await mkdir(join(dataDir, 'checkouts', USER, 'history'), { recursive: true });
    await writeFile(join(dataDir, 'checkouts', USER, 'history', 'p.jsonl'), join(dataDir, 'checkouts'));
    const before = await tree(dataDir);
    const error = await runTenancySteps(db.owner, dataDir, withRoot).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'tenancy-prefix-found' });
    expect((error as Error).message).toContain(`${USER}/workspaces/${WS}/tree/workspace.yaml`);
    expect((error as Error).message).not.toContain('notes.txt');
    expect((error as Error).message).not.toContain('history');
    expect(await tree(dataDir)).toEqual(before);
    expect((await readTenancyStep(db.owner))?.step).toBe('files');
    // Fixed by hand where it is, the next run finishes.
    await writeFile(join(dataDir, 'checkouts', USER, 'workspaces', WS, 'tree', 'workspace.yaml'), 'projects: []\n');
    expect(await runTenancySteps(db.owner, dataDir, withRoot)).toBe('done');
  });

  it('refuses a forward run while a revert has not finished', async () => {
    await db.owner.query("update server_identity set tenancy_step = 'reverting-files'");
    await expect(runTenancySteps(db.owner, dataDir, withRoot)).rejects.toMatchObject({ code: 'tenancy-reverting' });
  });

  it('migrate --check exits 1 while the step is not done; migrate runs it, then --check exits 0', async () => {
    await oldLayout(dataDir);
    const env = {
      WIREBENCH_SERVER_MIGRATION_DATABASE_URL: db.ownerUrl,
      WIREBENCH_SERVER_DATABASE_URL: db.url,
      WIREBENCH_SERVER_PUBLIC_URL: 'https://wirebench.test',
      WIREBENCH_SERVER_DATA_DIR: dataDir,
    };
    const run = async (args: string[]) => {
      const stdout = { write: vi.fn() };
      const stderr = { write: vi.fn() };
      const code = await main(args, { stdout, stderr, env });
      const text = [...stdout.write.mock.calls, ...stderr.write.mock.calls].map((c) => String(c[0])).join('');
      return { code, text };
    };
    const pending = await run(['migrate', '--check']);
    expect(pending.code).toBe(1);
    expect(pending.text).toContain('migrations: up to date');
    expect(pending.text).toContain('the move to the new layout is pending (step files)');
    expect(existsSync(join(dataDir, 'repos'))).toBe(true);
    const migrated = await run(['migrate']);
    expect(migrated.code).toBe(0);
    expect(migrated.text).toContain('data directory: in the new layout');
    expect(await tree(dataDir)).toEqual(movedLayout(await tenantId()));
    const after = await run(['migrate', '--check']);
    expect(after).toEqual({ code: 0, text: 'migrations: up to date\n' });
  });

  it('start-up runs the step before RepoStore.prepare: a refused step leaves no no-hooks/ or tenants/ tree made', async () => {
    await oldLayout(dataDir);
    const { rm } = await import('node:fs/promises');
    await rm(join(dataDir, 'no-hooks'), { recursive: true });
    const t = await tenantId();
    await mkdir(join(dataDir, 'tenants', t, 'checkouts'), { recursive: true });
    const before = await tree(dataDir);
    const env = {
      WIREBENCH_SERVER_MIGRATION_DATABASE_URL: db.ownerUrl,
      WIREBENCH_SERVER_DATABASE_URL: db.url,
      WIREBENCH_SERVER_PUBLIC_URL: 'https://wirebench.test',
      WIREBENCH_SERVER_DATA_DIR: dataDir,
      WIREBENCH_SERVER_HOST: '127.0.0.1',
      WIREBENCH_SERVER_PORT: String(await freePort()),
      WIREBENCH_SERVER_LOG_LEVEL: 'fatal',
    };
    const error = await startServer(
      env,
      { stdout: { write: vi.fn() }, stderr: { write: vi.fn() }, env },
      {
        signals: new EventEmitter(),
        exit: vi.fn(),
        modules: BUILTIN_MODULES,
      },
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StartupError);
    expect(error).toMatchObject({ exitCode: 2 });
    expect((error as Error).message).toContain('tenancy-move-conflict');
    expect(await tree(dataDir)).toEqual(before);
  });
});

describeDb('the file step on the frozen 0019 fixture', () => {
  let db: Awaited<ReturnType<typeof testDatabase>>;
  let dataDir: string;
  let fixture: Fixture0019;
  beforeEach(async () => {
    db = await testDatabase({ migrated: false });
    dataDir = await mkTempDir('wbs-file-step-0019-');
    fixture = await loadFixture0019(db.owner, dataDir);
    const { migrate } = await import('../../../src/db/migrate.js');
    const { allMigrations } = await import('../../../src/serve.js');
    await migrate(db.owner, await allMigrations(BUILTIN_MODULES));
  });
  afterEach(async () => {
    await db.close();
    await removeTempDir(dataDir);
  });
  /** The root the fixture's host sealed under. */
  const fixtureRoot = () => Buffer.from(fixture.keys.secretsKey, 'base64');

  it("moves the fixture's directories, keeps the removed workspace, drops the scratch, and its real checkout passes the scan", async () => {
    expect(await runTenancySteps(db.owner, dataDir, { root: fixtureRoot() })).toBe('done');
    const t = (await readTenancyStep(db.owner))!.defaultTenantId;
    const root = join(dataDir, 'tenants', t);
    expect((await readdir(dataDir)).sort()).toEqual(['no-hooks', 'tenants']);
    expect((await readdir(join(root, 'repos'))).sort()).toEqual(
      expect.arrayContaining([`${fixture.workspaces.staging}.git`, `${fixture.workspaces.billing}.git`]),
    );
    const tmp = await readdir(join(root, 'tmp'));
    expect(tmp).toHaveLength(1);
    expect(tmp[0]).toMatch(new RegExp(`^removed-${fixture.workspaces.retired}-`));
    const checkout = join(root, fixture.checkout);
    expect(existsSync(join(checkout, 'secrets.json'))).toBe(true);
    expect((await readdir(join(checkout, 'cookie-jars'))).sort()).toEqual(
      [`${fixture.workspaces.billing}.json`, `${fixture.workspaces.staging}.json`].sort(),
    );
    // The bare repositories' hooks path still names the data directory's own no-hooks/, which stays put.
    const config = await readFile(join(root, 'repos', `${fixture.workspaces.staging}.git`, 'config'), 'utf8');
    expect(config).toContain(join(dataDir, 'no-hooks'));
  });

  it('refuses when the fixture checkout holds a state file with the old prefix, naming it', async () => {
    const state = join(dataDir, fixture.checkout, 'workspace-state.json');
    await writeFile(state, JSON.stringify({ version: 1, linked: join(dataDir, fixture.checkout, 'projects', 'x') }));
    await expect(moveFiles(dataDir, (await readTenancyStep(db.owner))!.defaultTenantId)).rejects.toMatchObject({
      code: 'tenancy-prefix-found',
      message: expect.stringContaining(`${fixture.checkout.slice('checkouts/'.length)}/workspace-state.json`) as string,
    });
  });

  const envFor = (dir: string) => ({
    WIREBENCH_SERVER_MIGRATION_DATABASE_URL: db.ownerUrl,
    WIREBENCH_SERVER_DATABASE_URL: db.url,
    WIREBENCH_SERVER_PUBLIC_URL: 'https://wirebench.test',
    WIREBENCH_SERVER_DATA_DIR: dir,
    WIREBENCH_SERVER_SECRETS_KEY: fixture.keys.secretsKey,
  });
  const runIn = async (dir: string, args: string[]) => {
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const code = await main(args, { stdout, stderr, env: envFor(dir) });
    return {
      code,
      out: stdout.write.mock.calls.map((c) => String(c[0])).join(''),
      err: stderr.write.mock.calls.map((c) => String(c[0])).join(''),
    };
  };
  const start = async (dir: string) => {
    const env = {
      ...envFor(dir),
      WIREBENCH_SERVER_HOST: '127.0.0.1',
      WIREBENCH_SERVER_PORT: String(await freePort()),
      WIREBENCH_SERVER_LOG_LEVEL: 'fatal',
    };
    return startServer(
      env,
      { stdout: { write: vi.fn() }, stderr: { write: vi.fn() }, env },
      {
        signals: new EventEmitter(),
        exit: vi.fn(),
        modules: BUILTIN_MODULES,
      },
    );
  };

  it("migrate on the image's own empty /data leaves the step due; the server then moves its real volume (review C1)", async () => {
    // docker run … migrate without the volume: /data exists, and is empty.
    const imageData = await mkTempDir('wbs-image-data-');
    try {
      const migrated = await runIn(imageData, ['migrate']);
      expect(migrated.code).toBe(0);
      expect(migrated.err).toContain('tenancy-data-dir-empty');
      expect(migrated.err).toContain('WIREBENCH_SERVER_DATA_DIR');
      expect((await readTenancyStep(db.owner))?.step).toBe('files');
      expect(await readdir(imageData)).toEqual([]);
      // A server started there refuses too, rather than serve an empty tree.
      await expect(start(imageData)).rejects.toThrow(/tenancy-data-dir-empty/);
      expect(await readdir(imageData)).toEqual([]);
    } finally {
      await removeTempDir(imageData);
    }
    // The real volume.
    const server = await start(dataDir);
    try {
      expect((await readTenancyStep(db.owner))?.step).toBe('done');
      expect((await readdir(dataDir)).sort()).toEqual(['no-hooks', 'tenants']);
    } finally {
      await server.close();
    }
  });

  it('at done with repos/ and checkouts/ still at the root and their new places empty, the step re-arms and moves (fix-round review m2)', async () => {
    // A move recorded against another directory, which left only empty new places behind.
    await db.owner.query("update server_identity set tenancy_step = 'done'");
    const t = (await readTenancyStep(db.owner))!.defaultTenantId;
    await mkdir(join(dataDir, 'tenants', t, 'repos'), { recursive: true });
    // migrate --check counts the re-arm as pending (round 2 review m3), also where keys without the root is not.
    const check = await runIn(dataDir, ['migrate', '--check']);
    expect(check.code).toBe(1);
    expect(check.out).toContain(
      'data directory: the move to the new layout is pending (recorded as made, but repos/ and checkouts/ and tmp/ still at the root)',
    );
    await db.owner.query("update server_identity set tenancy_step = 'keys'");
    const noRoot: Record<string, string> = { ...envFor(dataDir) };
    delete noRoot.WIREBENCH_SERVER_SECRETS_KEY;
    const checkNoRoot = await main(['migrate', '--check'], {
      stdout: { write: vi.fn() },
      stderr: { write: vi.fn() },
      env: noRoot,
    });
    expect(checkNoRoot).toBe(1);
    await db.owner.query("update server_identity set tenancy_step = 'done'");
    // The start says so, on stderr and in its log (round 2 review m1), with no tenant or key in it.
    const stderr = { write: vi.fn() };
    const logged: string[] = [];
    const env = {
      ...envFor(dataDir),
      WIREBENCH_SERVER_HOST: '127.0.0.1',
      WIREBENCH_SERVER_PORT: String(await freePort()),
      WIREBENCH_SERVER_LOG_LEVEL: 'warn',
    };
    const server = await startServer(
      env,
      { stdout: { write: vi.fn() }, stderr, env },
      {
        signals: new EventEmitter(),
        exit: vi.fn(),
        modules: BUILTIN_MODULES,
        logStream: new Writable({
          write(chunk: Buffer, _encoding, done) {
            logged.push(chunk.toString());
            done();
          },
        }),
      },
    );
    try {
      expect((await readTenancyStep(db.owner))?.step).toBe('done');
      expect((await readdir(dataDir)).sort()).toEqual(['no-hooks', 'tenants']);
      expect((await readdir(join(dataDir, 'tenants', t, 'repos'))).length).toBeGreaterThan(0);
      const tmp = await readdir(join(dataDir, 'tenants', t, 'tmp'));
      expect(tmp.some((name) => name.startsWith(`removed-${fixture.workspaces.retired}-`))).toBe(true);
      const err = stderr.write.mock.calls.map((c) => String(c[0])).join('');
      const line =
        'data directory: the move to the new layout is recorded as made, but repos/ and checkouts/ and tmp/ are ' +
        'still at the root (a move made against another directory, or one cut short); moving them now';
      expect(err).toContain(line);
      expect(logged.join('')).toContain(line);
      for (const text of [err, logged.join('')]) {
        expect(text).not.toContain(t);
        expect(text).not.toContain(fixture.keys.secretsKey);
      }
    } finally {
      await server.close();
    }
    expect(await runIn(dataDir, ['migrate', '--check'])).toMatchObject({ code: 0 });
  });

  it('migrate re-arms a move recorded as made and says so on stderr (round 2 review m1)', async () => {
    await db.owner.query("update server_identity set tenancy_step = 'done'");
    const migrated = await runIn(dataDir, ['migrate']);
    expect(migrated.code).toBe(0);
    expect(migrated.err).toContain(
      'data directory: the move to the new layout is recorded as made, but repos/ and checkouts/ and tmp/ are still at the root',
    );
    expect(migrated.out).toContain('data directory: in the new layout');
    expect((await readdir(dataDir)).sort()).toEqual(['no-hooks', 'tenants']);
    expect((await readTenancyStep(db.owner))?.step).toBe('done');
  });

  it('at done, a data directory without the repository of a workspace made since is refused, not moved (round 2 review m2)', async () => {
    // A pre-upgrade backup, mounted after the real directory reached done: it predates one of the workspaces.
    await db.owner.query("update server_identity set tenancy_step = 'done'");
    const { rm } = await import('node:fs/promises');
    const afterSeal = '01M6515P844XKB9C2NTQDM7PYP';
    await rm(join(dataDir, 'repos', `${afterSeal}.git`), { recursive: true });
    const ledger = async () => (await db.owner.query('select version from schema_migrations order by 1')).rows;
    const before = { files: await tree(dataDir), ledger: await ledger() };
    const error = await start(dataDir).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StartupError);
    expect(error).toMatchObject({ exitCode: 2 });
    expect((error as Error).message).toContain('tenancy-workspaces-missing');
    expect((error as Error).message).toContain(`${afterSeal}.git`);
    const migrate = await runIn(dataDir, ['migrate']);
    expect(migrate.code).toBe(2);
    expect(migrate.err).toContain('tenancy-workspaces-missing');
    expect((await runIn(dataDir, ['migrate', '--check'])).code).toBe(1);
    // The step itself refuses too, before anything moves.
    await expect(runTenancySteps(db.owner, dataDir, { root: fixtureRoot() })).rejects.toMatchObject({
      code: 'tenancy-workspaces-missing',
    });
    expect({ files: await tree(dataDir), ledger: await ledger() }).toEqual(before);
    expect((await readTenancyStep(db.owner))?.step).toBe('done');
  });

  it('at done with repos/ still at the root and data at its new place, start and migrate refuse and change nothing', async () => {
    await db.owner.query("update server_identity set tenancy_step = 'done'");
    const t = (await readTenancyStep(db.owner))!.defaultTenantId;
    // The server has been used since: a repository exists at the new place.
    await mkdir(join(dataDir, 'tenants', t, 'repos', 'made-since.git'), { recursive: true });
    const ledger = async () => (await db.owner.query('select version from schema_migrations order by 1')).rows;
    const before = { files: await tree(dataDir), ledger: await ledger() };
    const error = await start(dataDir).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StartupError);
    expect(error).toMatchObject({ exitCode: 2 });
    expect((error as Error).message).toContain('tenancy-files-left-behind');
    expect((error as Error).message).toContain('repos/ and checkouts/');
    expect((error as Error).message).toContain('tmp/removed-');
    const migrate = await runIn(dataDir, ['migrate']);
    expect(migrate.code).toBe(2);
    expect(migrate.err).toContain('tenancy-files-left-behind');
    const check = await runIn(dataDir, ['migrate', '--check']);
    expect(check.code).toBe(1);
    expect({ files: await tree(dataDir), ledger: await ledger() }).toEqual(before);
    expect((await readTenancyStep(db.owner))?.step).toBe('done');
  });

  it('refuses a linked repos/ in the step, before anything moves, and stays at files (fix-round review I1)', async () => {
    const big = await mkTempDir('wbs-file-step-big-');
    try {
      const { rename, symlink } = await import('node:fs/promises');
      await rename(join(dataDir, 'repos'), join(big, 'repos'));
      await symlink(join(big, 'repos'), join(dataDir, 'repos'), 'dir');
      const before = await tree(dataDir);
      await expect(runTenancySteps(db.owner, dataDir, { root: fixtureRoot() })).rejects.toMatchObject({
        code: 'tenancy-move-link',
      });
      expect(await tree(dataDir)).toEqual(before);
      expect((await readTenancyStep(db.owner))?.step).toBe('files');
      // admin tenancy check says so beforehand.
      const report = await runIn(dataDir, ['admin', 'tenancy', 'check']);
      expect(report.out).toContain('links: repos/ is a symbolic link');
    } finally {
      await removeTempDir(big);
    }
  });
});
