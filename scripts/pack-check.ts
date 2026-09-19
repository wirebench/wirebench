/**
 * Packs `@wirebench/engine` and `@wirebench/cli` into tarballs the way `npm publish` would, so
 * CI can catch a publishable-package regression (a stray file leaking into the tarball, a
 * `development` export condition or `./test-helpers` subpath surviving into the published
 * manifest, a `workspace:` dependency version) before it reaches the registry.
 *
 * `packPackages` is the reusable half: it shells out to `pnpm --filter <pkg> pack`, which
 * applies each package's `publishConfig` (including the trimmed `exports` and the `workspace:*`
 * → real version rewrite) exactly as `npm publish` would, and runs the `prepack` script that
 * copies the root `LICENSE` in. `scripts/pack-check.test.ts` (the `scripts` vitest project)
 * extracts the tarballs and asserts on their contents; `node scripts/pack-check.ts` runs the
 * same pack for local/CI use as `pnpm pack:check`.
 *
 * No shell is used anywhere here: `execFileSync` is called with an argv array, never a shell
 * string, so package names and paths can't be reinterpreted by a shell.
 *
 * `pnpm pack` (pnpm 9.13.2) rejects `--filter` — filtering makes pnpm pick the recursive code
 * path, which `pack` does not implement (`Unknown option: 'recursive'`) — so each package is
 * packed by running `pnpm pack` with `cwd` set to that package's directory instead.
 */
import { execFileSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/** pnpm's own binary name on this platform: `pnpm.cmd` on Windows, `pnpm` everywhere else. */
const PNPM_BIN = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

/** Packs the workspace package at `packageDir` with `pnpm pack`, tarball written to `outDir`. */
function pack(packageDir: string, outDir: string): void {
  execFileSync(PNPM_BIN, ['pack', '--pack-destination', outDir], {
    cwd: packageDir,
    stdio: 'pipe',
  });
}

/** Finds the single `.tgz` pnpm just wrote to `outDir` for the given package. */
async function findTarball(outDir: string): Promise<string> {
  const entries = await readdir(outDir);
  const tarballs = entries.filter((entry) => entry.endsWith('.tgz'));
  if (tarballs.length !== 1) {
    throw new Error(`expected exactly one new tarball in ${outDir}, found: ${tarballs.join(', ')}`);
  }
  return join(outDir, tarballs[0]!);
}

/**
 * Packs `@wirebench/engine` and `@wirebench/cli` into `outDir` (via `pnpm --filter <pkg> pack`,
 * one tarball per package in its own subdirectory so the two `.tgz` files can't be confused) and
 * returns each tarball's path.
 */
export async function packPackages(outDir: string): Promise<{ engine: string; cli: string }> {
  const engineDir = join(outDir, 'engine');
  const cliDir = join(outDir, 'cli');

  pack(join(repoRoot, 'packages/engine'), engineDir);
  pack(join(repoRoot, 'packages/cli'), cliDir);

  const [engine, cli] = await Promise.all([findTarball(engineDir), findTarball(cliDir)]);
  return { engine, cli };
}

async function main(): Promise<void> {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const outDir = await mkdtemp(join(tmpdir(), 'wirebench-pack-check-'));
  try {
    const tarballs = await packPackages(outDir);
    process.stdout.write(`packed ${tarballs.engine}\npacked ${tarballs.cli}\n`);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], 'file:').href) {
  await main();
}
