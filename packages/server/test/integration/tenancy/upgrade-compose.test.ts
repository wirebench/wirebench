/**
 * Upgrading a compose installation at `0019` (plan Task 29; spec §19.4, owner ruling 2026-10-29): the frozen
 * fixture's database and data directory, as a team install left them, under this build's image.
 *
 * - The contributors' `packages/server/compose.yaml`, with its two URLs: the server creates `wirebench_app`,
 *   migrates, moves the data directory and starts, with no warning.
 * - The same volume with the old single URL: it starts on the owner, a superuser, and warns.
 * - The team install's root `docker-compose.yml` with its new `.env` line: an old volume gains `wirebench_app` and
 *   starts with no warning. Without the line, compose refuses to start at all.
 *
 * Each case loads the fixture into a fresh compose project. It needs Docker and an image of this build, so it runs
 * only when `WIREBENCH_SERVER_UPGRADE_IMAGE` names one (CI's `server-upgrade` job builds it); elsewhere it skips.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { FIXTURE_SECRETS_KEY, loadIntoCompose } from '../../fixtures/tenancy/volume.js';
import { freePort } from '../../helpers/net.js';

const run = promisify(execFile);
const IMAGE = process.env.WIREBENCH_SERVER_UPGRADE_IMAGE ?? '';
const REPO = join(import.meta.dirname, '..', '..', '..', '..', '..');
const CONTRIBUTORS_COMPOSE = join(REPO, 'packages', 'server', 'compose.yaml');
const TEAM_COMPOSE = join(REPO, 'docker-compose.yml');
const WARNING = 'row-level security cannot be relied on';
const TIMEOUT = 300_000;

/** One compose project: its arguments, its environment, and what to remove afterwards. */
interface Stack {
  readonly args: string[];
  readonly env: NodeJS.ProcessEnv;
  readonly port: number;
}

let stacks: Stack[] = [];
let scratch: string[] = [];
let tags: string[] = [];

afterEach(async () => {
  for (const stack of stacks) {
    await run('docker', ['compose', ...stack.args, 'down', '-v', '--remove-orphans'], { env: stack.env }).catch(
      () => undefined,
    );
  }
  for (const tag of tags) await run('docker', ['rmi', tag]).catch(() => undefined);
  for (const dir of scratch) await rm(dir, { recursive: true, force: true });
  stacks = [];
  scratch = [];
  tags = [];
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wbs-upgrade-'));
  scratch.push(dir);
  return dir;
}

function compose(stack: Stack, args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  return run('docker', ['compose', ...stack.args, ...args], { env: stack.env, maxBuffer: 64 * 1024 * 1024 });
}

/** One value from the stack's database, as `wirebench`. */
async function psql(stack: Stack, sql: string): Promise<string> {
  const { stdout } = await compose(stack, [
    'exec',
    '-T',
    'db',
    'psql',
    '-U',
    'wirebench',
    '-d',
    'wirebench',
    '-tAc',
    sql,
  ]);
  return stdout.trim();
}

/** Starts `db`, loads the fixture into it and into the data volume, then starts the server. */
async function startOnFixture(stack: Stack): Promise<void> {
  stacks.push(stack);
  await compose(stack, ['up', '-d', '--wait', '--pull', 'never', 'db']);
  loadIntoCompose(stack.args, { env: stack.env });
  await compose(stack, ['up', '-d', '--no-build', '--pull', 'never']);
}

/** Waits for `/healthz` to answer 200, and returns the server's log so far. */
async function healthy(stack: Stack): Promise<string> {
  let status = 0;
  for (let attempt = 0; attempt < 240 && status !== 200; attempt++) {
    await new Promise((done) => setTimeout(done, 500));
    status = await fetch(`http://127.0.0.1:${String(stack.port)}/healthz`).then(
      (response) => response.status,
      () => 0,
    );
  }
  const { stdout } = await compose(stack, ['logs', '--no-color', 'server']);
  expect(status, stdout).toBe(200);
  return stdout;
}

/** The fixture's admin signs in with the password it had at `0019`: the queries run, as whichever role. */
async function adminSignsIn(stack: Stack): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${String(stack.port)}/api/v1/auth/local/sign-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: 'admin@example.com',
      password: 'fixture-password-0019',
      device: { name: 'upgrade' },
    }),
  });
  expect(response.status).toBe(201);
}

/**
 * At `0026` (slice 5's operations tables, slice 7's control-plane tables, slice 8's custom domains and two-step sign-in's tables on top of `0021`), with the data directory moved. With the fixture's secrets key the browser-client values are re-sealed
 * too (`done`); without one the server generates and stores its own key at start-up, so the step reaches `done` as well.
 */
async function expectUpgraded(stack: Stack): Promise<void> {
  expect(await psql(stack, 'select max(version) from schema_migrations')).toBe('26');
  expect(await psql(stack, 'select tenancy_step from server_identity')).toBe('done');
  await adminSignsIn(stack);
}

/** The contributors' compose file with this build's image, the fixture's key, free ports and an override. */
async function contributorsStack(name: string, environment: string): Promise<Stack> {
  const dir = await tempDir();
  const override = join(dir, 'override.yaml');
  await writeFile(
    override,
    [
      'services:',
      '  server:',
      `    image: ${IMAGE}`,
      '    environment:',
      `      WIREBENCH_SERVER_SECRETS_KEY: '${FIXTURE_SECRETS_KEY}'`,
      environment,
      '',
    ].join('\n'),
  );
  const port = await freePort();
  return {
    args: ['-f', CONTRIBUTORS_COMPOSE, '-f', override, '-p', `wbs-upgrade-${name}-${String(process.pid)}`],
    env: {
      ...process.env,
      WIREBENCH_HTTP_PORT: String(port),
      WIREBENCH_DB_PORT: String(await freePort()),
    },
    port,
  };
}

describe.skipIf(IMAGE === '')('a compose installation at 0019, upgraded (plan Task 29)', () => {
  it(
    'under packages/server/compose.yaml: creates wirebench_app, migrates and starts with no warning',
    async () => {
      const stack = await contributorsStack('two-urls', '');
      await startOnFixture(stack);
      const log = await healthy(stack);
      expect(log).not.toContain(WARNING);
      expect(await psql(stack, "select rolsuper, rolbypassrls from pg_roles where rolname = 'wirebench_app'")).toBe(
        'f|f',
      );
      await expectUpgraded(stack);
    },
    TIMEOUT,
  );

  it(
    'with the old single URL: starts on the owner and warns',
    async () => {
      const stack = await contributorsStack(
        'one-url',
        [
          '      WIREBENCH_SERVER_MIGRATION_DATABASE_URL: !reset null',
          '      WIREBENCH_SERVER_DATABASE_URL: postgres://wirebench:wirebench@db:5432/wirebench',
        ].join('\n'),
      );
      await startOnFixture(stack);
      const log = await healthy(stack);
      expect(log).toContain(WARNING);
      expect(log).toMatch(/wirebench is a superuser/);
      expect(await psql(stack, "select count(*) from pg_roles where rolname = 'wirebench_app'")).toBe('0');
      await expectUpgraded(stack);
    },
    TIMEOUT,
  );

  it(
    'under the root docker-compose.yml with the new .env line: creates wirebench_app and starts with no warning',
    async () => {
      const dir = await tempDir();
      const port = await freePort();
      const version = `upgrade-test-${String(process.pid)}`;
      const tag = `ghcr.io/wirebench/wirebench-server:${version}`;
      await run('docker', ['tag', IMAGE, tag]);
      tags.push(tag);
      const settings = [
        `WIREBENCH_PUBLIC_URL=http://localhost:${String(port)}`,
        'POSTGRES_PASSWORD=0123456789abcdef0123456789abcdef0123456789abcdef',
        'WIREBENCH_ALLOW_HTTP=true',
        'WIREBENCH_TRUST_PROXY=false',
        `WIREBENCH_HTTP_PORT=${String(port)}`,
        `WIREBENCH_VERSION=${version}`,
      ];
      const old = join(dir, 'old.env');
      await writeFile(old, `${settings.join('\n')}\n`);
      const project = `wbs-upgrade-team-${String(process.pid)}`;
      const refused = await run('docker', ['compose', '-f', TEAM_COMPOSE, '--env-file', old, '-p', project, 'config'], {
        env: process.env,
      }).catch((error: { code?: number; stderr?: string }) => error);
      // An existing install that has not added the line: compose itself refuses, naming it.
      expect('code' in refused ? refused.code : 0).not.toBe(0);
      expect('stderr' in refused ? refused.stderr : '').toContain('set WIREBENCH_APP_DB_PASSWORD in .env');

      const env = join(dir, '.env');
      await writeFile(
        env,
        `${[...settings, 'WIREBENCH_APP_DB_PASSWORD=fedcba9876543210fedcba9876543210fedcba9876543210'].join('\n')}\n`,
      );
      const stack: Stack = { args: ['-f', TEAM_COMPOSE, '--env-file', env, '-p', project], env: process.env, port };
      await startOnFixture(stack);
      const log = await healthy(stack);
      expect(log).not.toContain(WARNING);
      expect(await psql(stack, "select rolsuper, rolbypassrls from pg_roles where rolname = 'wirebench_app'")).toBe(
        'f|f',
      );
      await expectUpgraded(stack);
    },
    TIMEOUT,
  );
});
