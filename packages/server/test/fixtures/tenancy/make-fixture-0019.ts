/**
 * Regenerates the frozen `0019` fixture (hosted edition spec §19.13): `seed-0019.sql`, `data-dir-0019.tar.gz`
 * and `fixture-0019.json`, next to this file. See README.md.
 *
 *   WIREBENCH_SERVER_TEST_DATABASE_URL=postgres://… node packages/server/test/fixtures/tenancy/make-fixture-0019.ts
 *
 * It checks out FIXTURE_COMMIT in a temporary worktree under `git-worktrees/`, installs and builds it, copies
 * `generate-0019.ts` in, and runs it there with that commit's vitest, so the rows and files come from that
 * commit's own code. The worktree is removed afterwards. `WIREBENCH_FIXTURE_PG_DUMP` names a `pg_dump` command
 * when none is on the PATH. `--in-place` runs the generator in this checkout instead: only for working on the
 * generator, never for the files that are checked in.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** The last commit whose schema is `0019`: the fixture is frozen at it. */
export const FIXTURE_COMMIT = 'e9bdc5af1';

const here = import.meta.dirname;
const repoRoot = resolve(here, '../../../../..');
const inPlace = process.argv.includes('--in-place');

function run(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv = process.env): void {
  execFileSync(command, args, { cwd, env, stdio: 'inherit' });
}

if (process.env.WIREBENCH_SERVER_TEST_DATABASE_URL === undefined) {
  throw new Error('set WIREBENCH_SERVER_TEST_DATABASE_URL to a superuser URL of a scratch database');
}
const worktree = inPlace ? repoRoot : join(repoRoot, 'git-worktrees', `fixture-0019-${process.pid}`);
const out = mkdtempSync(join(tmpdir(), 'wb-fixture-0019-'));
try {
  if (!inPlace) {
    run('git', ['worktree', 'add', '--detach', worktree, FIXTURE_COMMIT], repoRoot);
    run('pnpm', ['install', '--frozen-lockfile'], worktree);
  }
  const generator = join(worktree, 'packages/server/test/fixtures/tenancy/generate-0019.test.ts');
  mkdirSync(join(generator, '..'), { recursive: true });
  copyFileSync(join(here, 'generate-0019.ts'), generator);
  const config = join(worktree, 'vitest.fixture-0019.config.ts');
  writeFileSync(
    config,
    `export default { test: { include: ['packages/server/test/fixtures/tenancy/generate-0019.test.ts'],
      globalSetup: ['packages/server/test/integration/global-setup.ts'], testTimeout: 300000, hookTimeout: 120000 } };\n`,
  );
  try {
    run(process.execPath, [join(worktree, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config], worktree, {
      ...process.env,
      WIREBENCH_FIXTURE_OUT: out,
      WIREBENCH_FIXTURE_COMMIT: inPlace ? 'in-place' : FIXTURE_COMMIT,
    });
  } finally {
    rmSync(generator, { force: true });
    rmSync(config, { force: true });
  }
  for (const file of ['seed-0019.sql', 'data-dir-0019.tar.gz', 'fixture-0019.json']) {
    copyFileSync(join(out, file), join(here, file));
  }
  console.log(`wrote seed-0019.sql, data-dir-0019.tar.gz and fixture-0019.json from ${inPlace ? 'this checkout' : FIXTURE_COMMIT}`);
} finally {
  rmSync(out, { recursive: true, force: true });
  if (!inPlace) run('git', ['worktree', 'remove', '--force', worktree], repoRoot);
}
