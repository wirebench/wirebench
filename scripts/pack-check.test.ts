/**
 * Verifies the published-package shape of `@wirebench/engine` and `@wirebench/cli`: what a
 * tarball actually holds, and that a fresh `npm install` of both tarballs together resolves and
 * runs the CLI. This is the regression test for "the package publishes but doesn't work" — the
 * kind of bug that only shows up once the workspace protocol and dev-only export conditions are
 * gone and a real installer is doing real module resolution.
 *
 * `packPackages` is exported for reuse by later CI-recipes tasks that also need packed tarballs.
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { packPackages } from './pack-check.ts';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * Runs `tar` in `cwd` with the tarball as a relative path: the GNU tar on Windows
 * runners reads a `C:\…` argument as `host:path` and tries a remote archive.
 */
function tar(tarballPath: string, args: readonly string[], cwd: string): string {
  return execFileSync('tar', [...args, relative(cwd, tarballPath)], { cwd, encoding: 'utf-8' });
}

/** Lists a tarball's entries via `tar -tzf`, stripped of the npm `package/` prefix. */
function listTarballEntries(tarballPath: string): string[] {
  const output = tar(tarballPath, ['-tzf'], tmpdir());
  return output
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/^package\//, ''));
}

/** True when `entry` is allowed to be in a published tarball. */
function isAllowedEntry(entry: string): boolean {
  if (entry === 'dist' || entry === 'README.md' || entry === 'LICENSE' || entry === 'package.json') {
    return true;
  }
  return entry.startsWith('dist/');
}

describe('packPackages', () => {
  it('packs the engine and CLI tarballs whose contents contain only dist/, README.md, LICENSE, package.json', async () => {
    const outDir = await makeTempDir('wirebench-pack-check-');
    const tarballs = await packPackages(outDir);

    for (const tarballPath of [tarballs.engine, tarballs.cli]) {
      const entries = listTarballEntries(tarballPath);
      const disallowed = entries.filter((entry) => !isAllowedEntry(entry));
      expect(disallowed, `${tarballPath} contains disallowed entries`).toEqual([]);
    }
  }, 120_000);

  it('packs an engine manifest with no development export condition and no ./test-helpers subpath', async () => {
    const outDir = await makeTempDir('wirebench-pack-check-');
    const tarballs = await packPackages(outDir);

    const extractDir = await makeTempDir('wirebench-pack-check-extract-');
    tar(tarballs.engine, ['-xzf'], extractDir);
    const manifest = JSON.parse(await readFile(join(extractDir, 'package', 'package.json'), 'utf-8')) as {
      exports: Record<string, unknown>;
    };

    expect(JSON.stringify(manifest.exports)).not.toContain('development');
    expect(manifest.exports).not.toHaveProperty('./test-helpers');
  }, 120_000);

  it('packs a CLI manifest with no workspace: dependency versions', async () => {
    const outDir = await makeTempDir('wirebench-pack-check-');
    const tarballs = await packPackages(outDir);

    const extractDir = await makeTempDir('wirebench-pack-check-extract-');
    tar(tarballs.cli, ['-xzf'], extractDir);
    const manifest = JSON.parse(await readFile(join(extractDir, 'package', 'package.json'), 'utf-8')) as {
      dependencies?: Record<string, string>;
    };

    for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
      expect(version.startsWith('workspace:'), `${name} depends on ${version}`).toBe(false);
    }
  }, 120_000);

  it('installs both tarballs and runs the packed CLI, which prints the manifest version', async () => {
    const outDir = await makeTempDir('wirebench-pack-check-');
    const tarballs = await packPackages(outDir);

    const installDir = await makeTempDir('wirebench-pack-check-install-');
    execFileSync('npm', ['install', '--no-audit', '--no-fund', tarballs.engine, tarballs.cli], {
      cwd: installDir,
      shell: process.platform === 'win32',
      stdio: 'pipe',
    });

    const cliManifest = JSON.parse(await readFile(join(repoRoot, 'packages/cli/package.json'), 'utf-8')) as {
      version: string;
    };

    const output = execFileSync(
      process.execPath,
      [join(installDir, 'node_modules', '@wirebench', 'cli', 'dist', 'bin.js'), '--version'],
      { encoding: 'utf-8' },
    );

    expect(output.trim()).toBe(cliManifest.version);
  }, 600_000);
});
