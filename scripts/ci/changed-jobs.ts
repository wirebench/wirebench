/**
 * Which of CI's jobs a pull request's changes call for (`.github/workflows/ci.yml`, the `changes` job).
 *
 * Each job below names the workspace packages it builds or runs (its roots) and the other paths it reads. A job
 * runs when a changed file lies in one of its roots, in a workspace package one of them depends on (read from
 * the `package.json` files, so a new dependency counts the moment it is declared), or under one of its paths.
 *
 * Documentation (`docs/`, `docs-site/`, `site/`, Markdown and MDX anywhere) calls for nothing. Anything this
 * cannot place calls for everything: the workflows, the root's files (the lockfile, the root `package.json`, the
 * TypeScript and Vitest configs, `.dockerignore`…), and any folder not named here, such as `fixtures/`. So does
 * a change to a package no job's graph knows. Wrong in the cautious direction only: a job may run that did not
 * need to, never the other way round.
 *
 * `code` says whether anything but documentation changed: the Vitest, coverage and `check` jobs, which cover
 * every package, run on that alone.
 *
 * `git diff --name-only <base> HEAD | node scripts/ci/changed-jobs.ts` prints `name=true|false` lines, which the
 * workflow appends to `$GITHUB_OUTPUT`; `--all` prints every job as called for (pushes to `main`).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** A job's roots (workspace package names) and the other paths it reads (a folder ends in `/`). */
interface JobInputs {
  readonly roots: readonly string[];
  readonly paths: readonly string[];
  /** Paths inside its roots that are another job's, not this one's. */
  readonly except?: readonly string[];
}

const SERVER_TEST_ROLES = 'scripts/ci/server-test-roles.sql';

/** Keys are the output names the workflow reads (`needs.changes.outputs.<key>`). */
export const JOBS: Readonly<Record<string, JobInputs>> = {
  // The server's integration suites against PostgreSQL.
  server_integration: { roots: ['@wirebench/server'], paths: [SERVER_TEST_ROLES] },
  tenancy_postgres: { roots: ['@wirebench/server'], paths: [SERVER_TEST_ROLES] },
  // Both build the server image, which carries the browser build of the desktop's renderer.
  server_upgrade: {
    roots: ['@wirebench/server', '@wirebench/desktop'],
    paths: [SERVER_TEST_ROLES, 'scripts/check-browser-bundle.ts'],
  },
  browser_e2e: {
    // Its global setup also runs the built CLI's headless agent.
    roots: ['@wirebench/server', '@wirebench/desktop', '@wirebench/cli'],
    paths: ['e2e/browser/', 'e2e/package.json', 'scripts/check-browser-bundle.ts'],
  },
  // The CLI's image, its npm tarballs and the GitHub Action that installs them.
  image_smoke: { roots: ['@wirebench/cli'], paths: ['scripts/cli-smoke.ts'] },
  npm_smoke: { roots: ['@wirebench/cli'], paths: ['scripts/cli-smoke.ts', 'scripts/pack-check.ts'] },
  action_smoke: { roots: ['@wirebench/cli'], paths: ['action/', 'scripts/cli-smoke.ts', 'scripts/pack-check.ts'] },
  // The engine against a real KDC, and its WS-Security signatures against xmlsec1.
  kerberos_integration: { roots: ['@wirebench/engine'], paths: ['scripts/ci/kerberos-kdc.sh'] },
  wss_xmlsec: { roots: ['@wirebench/engine'], paths: ['scripts/wss-xmlsec-check.ts'] },
  // The desktop app end to end.
  e2e: { roots: ['@wirebench/desktop', '@wirebench/e2e'], paths: ['scripts/fuses.ts'], except: ['e2e/browser/'] },
};

/** Calls for nothing. */
export function isDocumentation(path: string): boolean {
  return /^(?:docs|docs-site|site)\//u.test(path) || /\.mdx?$/u.test(path);
}

/** Folders whose files this places: workspace packages, plus `scripts/` and `action/`, which jobs name by path. */
const PLACED_FOLDERS = /^(?:packages|apps)\/[^/]+\/|^e2e\/|^scripts\/|^action\//u;

/** A workspace package: its name, its folder (ending in `/`) and the workspace packages it depends on. */
export interface WorkspacePackage {
  readonly name: string;
  readonly dir: string;
  readonly deps: readonly string[];
}

/** The workspace's packages, read from `packages/*`, `apps/*` and `e2e`. */
export function readWorkspace(root: string): WorkspacePackage[] {
  const dirs = ['packages', 'apps'].flatMap((parent) =>
    readdirSync(join(root, parent), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${parent}/${entry.name}/`),
  );
  dirs.push('e2e/');
  const packages: WorkspacePackage[] = [];
  for (const dir of dirs) {
    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8')) as Record<string, unknown>;
    } catch {
      continue;
    }
    const deps = ['dependencies', 'devDependencies', 'peerDependencies'].flatMap((field) =>
      Object.keys((manifest[field] as Record<string, string> | undefined) ?? {}),
    );
    packages.push({ name: String(manifest['name']), dir, deps: deps.filter((dep) => dep.startsWith('@wirebench/')) });
  }
  return packages;
}

/** The folders of `roots` and of every workspace package they depend on, directly or not. */
function closureDirs(roots: readonly string[], workspace: readonly WorkspacePackage[]): string[] {
  const byName = new Map(workspace.map((pkg) => [pkg.name, pkg]));
  const seen = new Set<string>();
  const queue = [...roots];
  for (let name = queue.pop(); name !== undefined; name = queue.pop()) {
    if (seen.has(name)) continue;
    seen.add(name);
    queue.push(...(byName.get(name)?.deps ?? []));
  }
  return [...seen].flatMap((name) => {
    const dir = byName.get(name)?.dir;
    return dir === undefined ? [] : [dir];
  });
}

/** `prefix` is a folder when it ends in `/`, else one file. */
const under = (path: string, prefix: string) => (prefix.endsWith('/') ? path.startsWith(prefix) : path === prefix);

/** For each job, whether these changed files call for it; plus `code`, whether anything but documentation changed. */
export function changedJobs(files: readonly string[], workspace: readonly WorkspacePackage[]): Record<string, boolean> {
  const relevant = files.filter((file) => file !== '' && !isDocumentation(file));
  const packageDirs = workspace.map((pkg) => pkg.dir);
  const everything = relevant.some(
    (file) =>
      !PLACED_FOLDERS.test(file) ||
      (/^(?:packages|apps)\//u.test(file) && !packageDirs.some((dir) => file.startsWith(dir))),
  );
  const result: Record<string, boolean> = { code: relevant.length > 0 };
  for (const [job, { roots, paths, except = [] }] of Object.entries(JOBS)) {
    const prefixes = [...closureDirs(roots, workspace), ...paths];
    result[job] =
      everything ||
      relevant.some(
        (file) => prefixes.some((prefix) => under(file, prefix)) && !except.some((prefix) => under(file, prefix)),
      );
  }
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const result = process.argv.includes('--all')
    ? Object.fromEntries(['code', ...Object.keys(JOBS)].map((key) => [key, true]))
    : changedJobs(readFileSync(0, 'utf8').split(/\r?\n/u), readWorkspace(root));
  for (const [key, value] of Object.entries(result)) console.log(`${key}=${value}`);
}
