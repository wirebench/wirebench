import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WirebenchError } from '@wirebench/engine';
import type { ServerModule } from '../../src/context.js';
import { BUILTIN_MODULES } from '../../src/modules.js';
import { allMigrations, isConfigFailure, runMigrate, StartupError } from '../../src/serve.js';

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

  it('reads every folder of a module that brings more than one', async () => {
    const identity = await folder('0002_identity.sql');
    const capture = await folder('0003_capture.sql');
    const signatures = await folder('0004_signatures.sql');
    const hooks: ServerModule = {
      name: 'webhook-capture',
      migrationsDir: [capture, signatures],
      register: () => Promise.resolve(),
    };
    const combined = await allMigrations([moduleWith(identity), hooks]);
    expect(combined.map((m) => `${m.version}_${m.name}`)).toEqual([
      '1_init',
      '2_identity',
      '3_capture',
      '4_signatures',
    ]);
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

  it('adds the tenancy folder only to a list that reaches the version before it', async () => {
    const host = await folder('0001_init.sql');
    const identity = await folder('0002_identity.sql');
    const teams = await folder('0003_teams.sql');
    const tenancy = await folder('0004_tenancy.sql');
    const operations = await folder('0005_operations.sql');
    const customDomains = await folder('0006_custom-domains.sql');
    const full = await allMigrations(
      [moduleWith(identity), moduleWith(teams, 'teams-access')],
      host,
      tenancy,
      operations,
      customDomains,
    );
    expect(full.map((m) => `${m.version}_${m.name}`)).toEqual([
      '1_init',
      '2_identity',
      '3_teams',
      '4_tenancy',
      '5_operations',
      '6_custom-domains',
    ]);
    // A test's partial set stops short of all three, and is not refused for the gap.
    expect(
      (await allMigrations([moduleWith(identity)], host, tenancy, operations, customDomains)).map((m) => m.version),
    ).toEqual([1, 2]);
  });

  it('puts 0020_tenancy, 0021_tenant-isolation and 0022_operations after every built-in module, then 0023 to 0027', async () => {
    const versions = (await allMigrations(BUILTIN_MODULES)).map((m) => `${m.version}_${m.name}`);
    expect(versions.slice(-9)).toEqual([
      '19_agent-pairings',
      '20_tenancy',
      '21_tenant-isolation',
      '22_operations',
      '23_control-plane',
      '24_custom-domains',
      '25_signup-ref',
      '26_user-profile',
      '27_two-factor',
    ]);
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

describe('the refusals that exit with the Config code (Part A review)', () => {
  it("counts the control role's configuration refusals with the others, and nothing else", () => {
    for (const code of [
      'server-postgres-too-old',
      'tenancy-reverting',
      'tenancy-files-left-behind',
      'tenancy-workspaces-missing',
      'tenancy-control-url-invalid',
      'tenancy-control-password-missing',
      'tenancy-control-role-create-refused',
      'control-plane-role-shared',
      'control-plane-role-superuser',
      'control-plane-role-too-broad',
      'control-plane-role-owns',
      'control-plane-role-no-bypass',
    ]) {
      expect(isConfigFailure(new WirebenchError(code, 'x')), code).toBe(true);
    }
    expect(isConfigFailure(new WirebenchError('server-migration-failed', 'x'))).toBe(false);
    expect(isConfigFailure(Object.assign(new Error('x'), { code: 'control-plane-role-shared' }))).toBe(false);
  });
});
