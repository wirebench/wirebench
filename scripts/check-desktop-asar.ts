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

import { closeSync, existsSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Not followed: the app loads the vendored binding instead (`packages/host/src/kerberos.ts`). */
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

/** The top-level folders the `'!node_modules/{…}/**'` pattern in `electron-builder.yml` leaves out. */
export function excludedTopLevelPackages(builderYaml: string): string[] {
  const match = /'!node_modules\/\{([^}]+)\}\/\*\*'/.exec(builderYaml);
  return match?.[1]?.split(',') ?? [];
}

/**
 * The same walk as the asar check, over the installed tree instead of a packed one, so a pull request
 * learns what a release would: which `excluded` packages something the app loads depends on. Each
 * package resolves the way Node does from its real path, which in pnpm's store sits beside its own
 * dependencies. Peer dependencies are not followed: one the app needs is some other package's own
 * dependency, and the dev install would otherwise satisfy a peer like `electron` and walk its tree.
 */
export function excludedButNeeded(appDir: string, excluded: readonly string[]): string[] {
  const resolve = (name: string, from: string): string | undefined => {
    for (let dir = from; ; dir = dirname(dir)) {
      const candidate = join(dir, 'node_modules', name);
      if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
      if (dirname(dir) === dir) return undefined;
    }
  };
  const neededBy = new Map<string, string>();
  const reached = new Set<string>();
  const queue = [realpathSync(appDir)];
  while (queue.length > 0) {
    const dir = queue.shift();
    if (dir === undefined) continue;
    const found = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Manifest & { name?: string };
    const by = found.name ?? dir;
    const follow = (names: Record<string, string> | undefined, onlyIfPresent: boolean): void => {
      for (const name of Object.keys(names ?? {})) {
        if (NOT_LOADED.has(name)) continue;
        const target = resolve(name, dir);
        if (target === undefined) {
          if (!onlyIfPresent) throw new Error(`${name} is not installed, and ${by} depends on it`);
          continue;
        }
        if (!neededBy.has(name)) neededBy.set(name, by);
        if (reached.has(target)) continue;
        reached.add(target);
        queue.push(target);
      }
    };
    follow(found.dependencies, false);
    follow(found.optionalDependencies, true);
  }
  return excluded
    .filter((name) => neededBy.has(name))
    .map((name) => `${name} is excluded, and ${neededBy.get(name)} depends on it`);
}

/** A package.json `exports` or `imports` target: a path, or conditions to pick one by. */
type Target = string | null | { readonly [condition: string]: Target };

/** The conditions Node matches when the main process imports a module, in the order it tries them. */
const CONDITIONS = ['node', 'import', 'default'];

function pickTarget(target: Target | undefined): string | undefined {
  if (target === undefined || target === null) return undefined;
  if (typeof target === 'string') return target;
  for (const [condition, inner] of Object.entries(target)) {
    if (CONDITIONS.includes(condition)) {
      const picked = pickTarget(inner);
      if (picked !== undefined) return picked;
    }
  }
  return undefined;
}

/** Matches `request` against an `exports` or `imports` map: an exact key, or a key with one `*`. */
function mapRequest(map: Record<string, Target> | undefined, request: string): string | undefined {
  if (map === undefined) return undefined;
  if (request in map) return pickTarget(map[request]);
  for (const [key, target] of Object.entries(map)) {
    const star = key.indexOf('*');
    if (star < 0) continue;
    const [prefix, suffix] = [key.slice(0, star), key.slice(star + 1)];
    if (request.length < key.length - 1 || !request.startsWith(prefix) || !request.endsWith(suffix)) continue;
    const picked = pickTarget(target);
    return picked?.replaceAll('*', request.slice(prefix.length, request.length - suffix.length));
  }
  return undefined;
}

/** `import … from '…'`, `export … from '…'` and `import('…')` with a literal specifier. */
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])([^'"\n]+)\1/g;

/**
 * Every module a workspace package in the asar imports must be in the asar too, resolved the way Node
 * resolves it: a relative path, a `#…` entry of the package's `imports`, or another `@wirebench/…`
 * package through its `exports`. The package walk above cannot see a folder that a broad exclusion
 * drops from inside a package: 7.0.0-rc.1 shipped without `protocol-rest`'s `dist/rest/docs/`, which
 * the `{test,__tests__,docs,…}` exclusion matched, and the app stopped at start-up.
 */
export function unresolvedWorkspaceImports(asarPath: string): string[] {
  const { header, read } = readAsar(asarPath);
  const isFile = (file: string): boolean => {
    let entry: AsarEntry | undefined = header;
    for (const part of file.split('/')) entry = entry?.files?.[part];
    return entry?.size !== undefined;
  };
  interface Maps {
    readonly exports?: Record<string, Target> | string;
    readonly imports?: Record<string, Target>;
  }
  const manifests = new Map<string, Maps>();
  const manifestOf = (dir: string): Maps => {
    let found = manifests.get(dir);
    if (found === undefined) {
      found = JSON.parse(read(`${dir}/package.json`) ?? '{}') as Maps;
      manifests.set(dir, found);
    }
    return found;
  };
  // A bare `@wirebench/name/sub` request, through that package's `exports`.
  const resolveBare = (request: string): string | undefined => {
    const [scope, name, ...rest] = request.split('/');
    const dir = `node_modules/${scope}/${name}`;
    if (read(`${dir}/package.json`) === undefined) return undefined;
    const exports = manifestOf(dir).exports;
    const sub = rest.length === 0 ? '.' : `./${rest.join('/')}`;
    const target = typeof exports === 'string' ? (sub === '.' ? exports : undefined) : mapRequest(exports, sub);
    return target === undefined ? undefined : posix.normalize(`${dir}/${target}`);
  };

  const problems: string[] = [];
  const files: string[] = [];
  const collect = (entry: AsarEntry, path: string): void => {
    for (const [name, child] of Object.entries(entry.files ?? {})) {
      const childPath = `${path}/${name}`;
      if (child.files !== undefined) collect(child, childPath);
      else if (name.endsWith('.js') && !child.unpacked) files.push(childPath);
    }
  };
  for (const name of topLevelPackages(header).filter((pkg) => pkg.startsWith('@wirebench/'))) {
    const entry = header.files?.node_modules?.files?.['@wirebench']?.files?.[name.slice('@wirebench/'.length)];
    if (entry !== undefined) collect(entry, `node_modules/${name}`);
  }
  for (const file of files.sort()) {
    const pkgDir = file.split('/').slice(0, 3).join('/');
    const source = read(file) ?? '';
    for (const match of source.matchAll(SPECIFIER)) {
      const request = match[2] ?? '';
      let resolved: string | undefined;
      if (request.startsWith('.')) resolved = posix.normalize(`${posix.dirname(file)}/${request}`);
      else if (request.startsWith('#')) {
        const target = mapRequest(manifestOf(pkgDir).imports, request);
        if (target === undefined) resolved = undefined;
        else resolved = target.startsWith('.') ? posix.normalize(`${pkgDir}/${target}`) : resolveBare(target);
      } else if (request.startsWith('@wirebench/')) resolved = resolveBare(request);
      else continue;
      if (resolved === undefined || !isFile(resolved)) {
        problems.push(`${file.slice('node_modules/'.length)} imports ${request}, which is not in the asar`);
      }
    }
  }
  return problems;
}

export function checkDesktopAsar(resourcesDirs: readonly string[]): string[] {
  return resourcesDirs.flatMap((dir) => {
    const asar = join(dir, 'app.asar');
    return [...checkAsarDependencies(asar), ...unresolvedWorkspaceImports(asar)].map(
      (problem) => `${asar}: ${problem}`,
    );
  });
}

if (process.argv[1] !== undefined && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  const dirs = process.argv.slice(2);
  const problems = checkDesktopAsar(dirs);
  for (const problem of problems) console.error(`desktop asar: ${problem}`);
  if (problems.length > 0 || dirs.length === 0) process.exit(1);
  console.log(
    `desktop asar: ${dirs.length} build(s) ship exactly the packages the app depends on, and every module they import`,
  );
}
