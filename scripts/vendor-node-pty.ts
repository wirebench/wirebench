/**
 * Vendors the local terminal's pty binding (#410) for every architecture of one platform into
 * apps/desktop/build-resources/node-pty/node-pty-<platform>-<arch>/, as the package `@lydell/node-pty` requires
 * at run time (`@lydell/node-pty-<platform>-<arch>`). electron-builder maps the folders into the app's
 * `node_modules/@lydell/` in place of the one binding pnpm installed for the runner.
 *
 * The release jobs pack several architectures from one install with npmRebuild off, as for Kerberos
 * (ADR-0019), so the installed binding only matches the runner. This downloads the registry tarball of each
 * binding at the version apps/desktop pins, and refuses any whose integrity differs from pnpm-lock.yaml: the
 * lockfile already records a sha512 for every platform's binding, so upgrading the package updates both.
 *
 *   node scripts/vendor-node-pty.ts [darwin|linux|win32]
 */

import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readTarGz } from './lib/tar.ts';
import { download } from './vendor-kerberos.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_OUT_DIR = join(ROOT, 'apps', 'desktop', 'build-resources', 'node-pty');
const PACKAGE = '@lydell/node-pty';

type Platform = 'darwin' | 'linux' | 'win32';

/** Files of a binding package the app never reads: debug symbols and the readme. */
const SKIPPED = /(\.pdb|README\.md)$/;
/** Files that must stay executable: macOS starts the shell through `spawn-helper`. */
const EXECUTABLE = /(^|\/)spawn-helper$|\.exe$/;

/** `{ 'darwin-arm64': 'sha512-…' }`: each binding of `platform` the lockfile records at `version`. */
export function lockedBindings(lock: string, version: string, platform: Platform): Record<string, string> {
  const pins: Record<string, string> = {};
  const entry =
    /^ {2}'@lydell\/node-pty-([a-z0-9]+-[a-z0-9]+)@([^']+)':\n {4}resolution: \{integrity: (sha512-[^}]+)\}/gm;
  for (const match of lock.matchAll(entry)) {
    const [, target, at, integrity] = match;
    if (target === undefined || integrity === undefined || at !== version) continue;
    if (target.startsWith(`${platform}-`)) pins[target] = integrity;
  }
  return pins;
}

export async function vendorNodePty(options: {
  readonly platform: Platform;
  readonly version: string;
  readonly outDir: string;
  readonly pins: Readonly<Record<string, string>>;
  readonly fetchBytes?: (url: string) => Promise<Buffer>;
}): Promise<string[]> {
  const fetchBytes = options.fetchBytes ?? download;
  const targets = Object.keys(options.pins).sort();
  if (targets.length === 0) throw new Error(`No locked node-pty bindings for ${options.platform}`);
  const extracted: (readonly [string, { name: string; bytes: Uint8Array }[]])[] = [];
  for (const target of targets) {
    const name = `node-pty-${target}`;
    const url = `https://registry.npmjs.org/${PACKAGE}-${target}/-/${name}-${options.version}.tgz`;
    const bytes = await fetchBytes(url);
    const actual = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
    if (actual !== options.pins[target]) {
      throw new Error(
        `node-pty: integrity mismatch for ${target}: expected ${String(options.pins[target])}, got ${actual} (${url})`,
      );
    }
    const files = readTarGz(new Uint8Array(bytes))
      .filter((entry) => entry.name.startsWith('package/') && !SKIPPED.test(entry.name))
      .map((entry) => ({ name: entry.name.slice('package/'.length), bytes: entry.bytes }));
    extracted.push([name, files]);
  }
  // Everything is verified before anything is written: a mismatch leaves the previous folder as it was.
  await rm(options.outDir, { recursive: true, force: true });
  const written: string[] = [];
  for (const [name, files] of extracted) {
    const dir = join(options.outDir, name);
    for (const file of files) {
      const target = join(dir, file.name);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.bytes);
      if (EXECUTABLE.test(file.name)) await chmod(target, 0o755);
    }
    written.push(dir);
  }
  return written;
}

if (process.argv[1] !== undefined && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  const requested = process.argv[2] ?? process.platform;
  if (requested !== 'darwin' && requested !== 'linux' && requested !== 'win32') {
    console.error(`node-pty: unsupported platform "${requested}"; use darwin, linux or win32.`);
    process.exit(1);
  }
  const desktop = JSON.parse(await readFile(join(ROOT, 'apps', 'desktop', 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
  };
  const version = desktop.dependencies[PACKAGE];
  if (version === undefined || !/^\d+\.\d+\.\d+/.test(version)) {
    console.error(`node-pty: apps/desktop must pin ${PACKAGE} to an exact version (found ${String(version)}).`);
    process.exit(1);
  }
  const pins = lockedBindings(await readFile(join(ROOT, 'pnpm-lock.yaml'), 'utf8'), version, requested);
  const written = await vendorNodePty({ platform: requested, version, outDir: DEFAULT_OUT_DIR, pins });
  console.log(`node-pty: vendored ${String(written.length)} binding(s) for ${requested}`);
}
