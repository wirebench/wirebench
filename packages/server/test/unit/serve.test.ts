import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerModule } from '../../src/context.js';
import { allMigrations, runMigrate, StartupError } from '../../src/serve.js';

/** The StartupError `allMigrations` rejects with, for asserting its code and message. */
async function refusal(modules: readonly ServerModule[], hostDir?: string): Promise<StartupError> {
  const error = await allMigrations(modules, hostDir).then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(StartupError);
  return error as StartupError;
}

/** A module whose only contribution is a migrations folder. */
const moduleWith = (migrationsDir: string, name: ServerModule['name'] = 'identity'): ServerModule => ({
  name,
  migrationsDir,
  register: () => Promise.resolve(),
});

describe('allMigrations', () => {
  let dirs: string[];
  const folder = async (...files: string[]): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'wbs-migrations-'));
    dirs.push(dir);
    for (const file of files) await writeFile(join(dir, file), 'select 1;');
    return dir;
  };
  beforeEach(() => {
    dirs = [];
  });
  afterEach(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  });

  it('is the host folder alone when no module brings migrations', async () => {
    expect((await allMigrations([])).map((m) => m.version)).toEqual([1]);
  });

  it('appends module folders that start after the host, in version order', async () => {
    const identity = await folder('0002_identity.sql');
    const teams = await folder('0003_teams.sql', '0004_access.sql');
    const combined = await allMigrations([moduleWith(teams, 'teams-access'), moduleWith(identity)]);
    expect(combined.map((m) => `${m.version}_${m.name}`)).toEqual(['1_init', '2_identity', '3_teams', '4_access']);
  });

  it('refuses a gap across folders', async () => {
    const error = await refusal([moduleWith(await folder('0003_teams.sql'))]);
    expect(error.exitCode).toBe(3);
    expect(error.message).toContain('not contiguous at 3');
  });

  it('refuses the same version in two folders', async () => {
    const clash = await refusal([moduleWith(await folder('0001_clash.sql'))]);
    expect(clash.exitCode).toBe(3);
    expect(clash.message).toContain('duplicate migration version 1');
    const a = await folder('0002_identity.sql');
    const b = await folder('0002_teams.sql');
    expect((await refusal([moduleWith(a), moduleWith(b, 'teams-access')])).message).toContain(
      'duplicate migration version 2',
    );
  });

  it('lets the host folder have a gap that module folders fill', async () => {
    const host = await folder('0001_init.sql', '0005_later.sql');
    const identity = await folder('0002_identity.sql');
    const teams = await folder('0003_teams.sql', '0004_access.sql');
    const combined = await allMigrations([moduleWith(identity), moduleWith(teams, 'teams-access')], host);
    expect(combined.map((m) => m.version)).toEqual([1, 2, 3, 4, 5]);
    expect((await refusal([moduleWith(identity)], host)).message).toContain('not contiguous at 5');
  });
});

describe('runMigrate', () => {
  const VARIABLE = 'WIREBENCH_SERVER_DATABASE_URL';
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env[VARIABLE];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[VARIABLE];
    else process.env[VARIABLE] = saved;
  });

  it('removes the database URL from process.env once configuration is loaded, so git never inherits it', async () => {
    const url = 'postgres://leak:leak@127.0.0.1:1/nothing';
    process.env[VARIABLE] = url;
    const io = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() }, env: { ...process.env } };
    const code = await runMigrate({ [VARIABLE]: url, WIREBENCH_SERVER_PUBLIC_URL: 'https://wirebench.test' }, io, true);
    expect(code).toBe(3); // nothing listens on port 1
    expect(process.env[VARIABLE]).toBeUndefined();
  });
});
