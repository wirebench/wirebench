/**
 * Asserts that each packed desktop app's `node_modules` is exactly what the app needs: every package
 * reachable from the app's own `dependencies` is present, and nothing else is. The second half is what
 * keeps the tree that only the (vendored, never loaded) `kerberos` package pulls in — `prebuild-install`
 * and friends — out of the asar; the first half is what proves excluding it broke no package that
 * shares one of its dependencies (ADR-0019).
 *
 * `kerberos` itself is the one dependency not followed: the app loads the binding vendored under
 * `resources/kerberos/`, never the package. An optional or peer dependency counts only where it is
 * present, since `electron` and the like are the runtime rather than something to pack.
 *
 *   node scripts/check-desktop-asar.ts <resources dir>...
 */

import { closeSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Not followed: the app loads the vendored binding instead (`apps/desktop/src/main/kerberos.ts`). */
const NOT_LOADED = new Set(['kerberos']);

interface AsarEntry {
  readonly files?: Record<string, AsarEntry>;
  readonly offset?: string;
  readonly size?: number;
  readonly unpacked?: boolean;
}

interface Manifest {
  readonly dependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
}

/** The asar header is a pickled size, then a pickled JSON string describing every file. */
function readAsar(path: string): { header: AsarEntry; read: (file: string) => string | undefined } {
  const fd = openSync(path, 'r');
  let headerSize: number;
  let header: AsarEntry;
  try {
    const sizes = Buffer.alloc(16);
    readSync(fd, sizes, 0, 16, 0);
    headerSize = sizes.readUInt32LE(4);
    const json = Buffer.alloc(sizes.readUInt32LE(12));
    readSync(fd, json, 0, json.length, 16);
    header = JSON.parse(json.toString('utf8')) as AsarEntry;
  } finally {
    closeSync(fd);
  }
  const read = (file: string): string | undefined => {
    let entry: AsarEntry | undefined = header;
    for (const part of file.split('/')) entry = entry?.files?.[part];
    if (entry?.size === undefined) return undefined;
    if (entry.unpacked === true) return readFileSync(join(`${path}.unpacked`, file), 'utf8');
    const content = Buffer.alloc(entry.size);
    const fd = openSync(path, 'r');
    try {
      readSync(fd, content, 0, entry.size, 8 + headerSize + Number(entry.offset));
    } finally {
      closeSync(fd);
    }
    return content.toString('utf8');
  };
  return { header, read };
}

/** The packages at the top of the asar's `node_modules`, scoped ones by their full name. */
function topLevelPackages(header: AsarEntry): string[] {
  const names: string[] = [];
  for (const [name, entry] of Object.entries(header.files?.node_modules?.files ?? {})) {
    if (name.startsWith('.')) continue;
    if (name.startsWith('@')) names.push(...Object.keys(entry.files ?? {}).map((scoped) => `${name}/${scoped}`));
    else names.push(name);
  }
  return names;
}

export function checkAsarDependencies(asarPath: string): string[] {
  const { header, read } = readAsar(asarPath);
  const manifest = (file: string): Manifest | undefined => {
    const text = read(file);
    return text === undefined ? undefined : (JSON.parse(text) as Manifest);
  };
  const app = manifest('package.json');
  if (app === undefined) return ['it has no package.json'];

  const problems: string[] = [];
  const reached = new Set<string>();
  // Node resolves a dependency from the package's own nested node_modules first, then the top level.
  const resolve = (name: string, from: string): string | undefined =>
    [`${from}node_modules/${name}`, `node_modules/${name}`].find((dir) => read(`${dir}/package.json`) !== undefined);
  const queue = Object.keys(app.dependencies ?? {}).map((name) => ({ name, from: '', by: 'the app' }));
  while (queue.length > 0) {
    const job = queue.shift();
    if (job === undefined || NOT_LOADED.has(job.name)) continue;
    const dir = resolve(job.name, job.from);
    if (dir === undefined) {
      problems.push(`${job.name} is missing, and ${job.by} depends on it`);
      continue;
    }
    if (reached.has(dir)) continue;
    reached.add(dir);
    const found = manifest(`${dir}/package.json`) ?? {};
    const follow = (names: Record<string, string> | undefined, onlyIfPresent: boolean): void => {
      for (const name of Object.keys(names ?? {})) {
        if (onlyIfPresent && resolve(name, `${dir}/`) === undefined) continue;
        queue.push({ name, from: `${dir}/`, by: job.name });
      }
    };
    follow(found.dependencies, false);
    follow(found.optionalDependencies, true);
    follow(found.peerDependencies, true);
  }
  for (const name of topLevelPackages(header).sort()) {
    if (!reached.has(`node_modules/${name}`)) problems.push(`${name} ships, but nothing the app loads depends on it`);
  }
  return problems;
}

export function checkDesktopAsar(resourcesDirs: readonly string[]): string[] {
  return resourcesDirs.flatMap((dir) => {
    const asar = join(dir, 'app.asar');
    return checkAsarDependencies(asar).map((problem) => `${asar}: ${problem}`);
  });
}

if (process.argv[1] !== undefined && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  const dirs = process.argv.slice(2);
  const problems = checkDesktopAsar(dirs);
  for (const problem of problems) console.error(`desktop asar: ${problem}`);
  if (problems.length > 0 || dirs.length === 0) process.exit(1);
  console.log(`desktop asar: ${dirs.length} build(s) ship exactly the packages the app depends on`);
}
