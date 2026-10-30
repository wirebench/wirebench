/**
 * The backstop of the scope in the signature (hosted edition spec §19.8, guard 2). Every rule reads the
 * TypeScript syntax tree, so comments never count, and an optional call, an element access, a destructuring, a
 * call split across lines or an alias is still a hit.
 *
 * - **No `defaultScope` or `scopeOf` outside the files {@link SCOPE_MINTS} names**, `src/tenancy/` included. A
 *   route or a module that reached for the default tenant, or branded a scope of its own, would pass every
 *   one-tenant test and serve the wrong tenant in hosted mode, so the name itself is refused, not only a call.
 *   Listing the files inside `src/tenancy/` too keeps a wrapper from re-exporting either. The admin command
 *   line's self-hosted default (§19.11) is on the list: `identity/cli.ts` serves the default tenant until
 *   Task 16 adds `--tenant`.
 * - **No `directoryOf` outside the files {@link SCOPE_MINTS} names** (Task 6 review m2): the directory's
 *   `list()`, `get(id)` and `resolvable()` hand out scopes, so it is kept off `ctx.tenancy`, and only the
 *   start-up, the resolver's registration and the admin command line reach it.
 * - **No `TenantDirectory` or `TenantAdmin` outside `src/tenancy/`** (Task 8 review I2), in an import, a `new`,
 *   a type or an alias: `new TenantDirectory(ctx.db).list()` would hand a module every tenant's scope, the hole
 *   `directoryOf` closes.
 * - **No read of the configured public URL** (§19.5) outside {@link PUBLIC_URL_ALLOWED} (`config.ts` and
 *   `tenancy/urls.ts`, file by file, so a second wrapper in `src/tenancy/` is caught too): no `.publicUrl`,
 *   `['publicUrl']`, `'publicUrl'` (a `Pick` that would carry it), destructuring of it, or its variable
 *   `WIREBENCH_SERVER_PUBLIC_URL` (`process.env` read around the config). A module takes the tenant's URL from
 *   `tenantUrl(config, request)`, so it cannot keep a copy made at registration. `operatorPublicUrl` is the
 *   operator's own output, in `main.ts` and `serve.ts` only, and `urlWithoutScope`, the URL where no scope
 *   exists yet, has the callers {@link URL_WITHOUT_SCOPE_ALLOWED} names. Names built at run time
 *   (`config['public' + 'Url']`) are not caught; they are not a mistake anyone makes by accident.
 *
 * Task 17 adds the gate's other rules.
 *
 * `node scripts/check-tenant-scope.ts` prints the result and exits non-zero, listing `file:line`, on any hit.
 * Wired into `pnpm check` as `pnpm check:tenant-scope`. ESLint's config is protected, which is why this is a
 * script.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/** The server's source, the only tree the gate reads: tests may build any scope they like. */
export const SOURCE_ROOT = 'packages/server/src';

/** Where the URL functions are defined, and so the one file of `src/tenancy/` that reads the configured URL. */
export const URLS_FILE = 'packages/server/src/tenancy/urls.ts';

/** The two ways to get a `TenantScope` without a request or the job loop, and the only files that may name them. */
export const SCOPE_MINTS: Readonly<Record<'defaultScope' | 'scopeOf' | 'directoryOf', readonly string[]>> = {
  defaultScope: [
    'packages/server/src/tenancy/directory.ts',
    'packages/server/src/tenancy/resolve.ts',
    'packages/server/src/identity/cli.ts',
  ],
  scopeOf: ['packages/server/src/tenancy/scope.ts', 'packages/server/src/tenancy/directory.ts'],
  directoryOf: [
    'packages/server/src/tenancy/tenancy.ts',
    'packages/server/src/server.ts',
    'packages/server/src/serve.ts',
    'packages/server/src/identity/cli.ts',
  ],
};

/** The tenant directory's classes, which only `src/tenancy/` may name (Task 8 review I2). */
export const TENANCY_ONLY: readonly string[] = ['TenantDirectory', 'TenantAdmin'];
export const TENANCY_DIR = 'packages/server/src/tenancy/';

/** Where the configured URL may be read: the config itself, and the tenant URL functions. */
export const PUBLIC_URL_ALLOWED: readonly string[] = ['packages/server/src/config.ts', URLS_FILE];

/** Where the URL's environment variable may be named: the config, which loads and documents it. */
export const PUBLIC_URL_ENV = 'WIREBENCH_SERVER_PUBLIC_URL';
export const PUBLIC_URL_ENV_ALLOWED: readonly string[] = ['packages/server/src/config.ts'];

/** The operator's own output (spec §19.5), and the file that defines it. */
export const OPERATOR_URL_ALLOWED: readonly string[] = [
  'packages/server/src/main.ts',
  'packages/server/src/serve.ts',
  URLS_FILE,
];

/**
 * Where nothing gives a scope yet (`tenancy/urls.ts`): the admin command line until Task 16, the scheduler's
 * alert links until Task 13, and the server-wide SAML provider until slice 7.
 */
export const URL_WITHOUT_SCOPE_ALLOWED: readonly string[] = [
  'packages/server/src/identity/cli.ts',
  'packages/server/src/schedules/settings.ts',
  'packages/server/src/sso/module.ts',
  URLS_FILE,
];

export interface ScopeHit {
  readonly file: string;
  readonly line: number;
  readonly text: string;
  /** Which rule it broke. */
  readonly rule:
    | 'default-scope'
    | 'scope-of'
    | 'directory-of'
    | 'tenant-directory'
    | 'public-url'
    | 'operator-url'
    | 'url-without-scope';
}

const PUBLIC_URL = 'publicUrl';

/**
 * Every read of the configured public URL in `content`, and every use of the two unscoped URL functions
 * outside their files. Read from the syntax tree, so comments never count, and an optional chain, an element
 * access, a destructuring or an alias of either function is still a hit.
 */
export function findUrlReads(file: string, content: string): ScopeHit[] {
  const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const hits: ScopeHit[] = [];
  const lines = content.split('\n');
  const hit = (node: ts.Node, rule: NonNullable<ScopeHit['rule']>): void => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line;
    hits.push({ file, line: line + 1, text: (lines[line] ?? '').trim(), rule });
  };
  const publicUrlAllowed = PUBLIC_URL_ALLOWED.includes(file);
  const visit = (node: ts.Node): void => {
    if (!publicUrlAllowed) {
      if (ts.isPropertyAccessExpression(node) && node.name.text === PUBLIC_URL) hit(node.name, 'public-url');
      else if (ts.isStringLiteralLike(node) && node.text === PUBLIC_URL) hit(node, 'public-url');
      else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
        const key = node.propertyName ?? node.name;
        if ((ts.isIdentifier(key) || ts.isStringLiteralLike(key)) && key.text === PUBLIC_URL) hit(node, 'public-url');
      }
    }
    if (
      (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) &&
      node.text === PUBLIC_URL_ENV &&
      !PUBLIC_URL_ENV_ALLOWED.includes(file)
    )
      hit(node, 'public-url');
    if (ts.isIdentifier(node)) {
      if (node.text === 'operatorPublicUrl' && !OPERATOR_URL_ALLOWED.includes(file)) hit(node, 'operator-url');
      if (node.text === 'urlWithoutScope' && !URL_WITHOUT_SCOPE_ALLOWED.includes(file)) hit(node, 'url-without-scope');
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits;
}

/**
 * Every identifier or string naming one of {@link SCOPE_MINTS} in `content`, unless `file` may name it, and
 * every naming of {@link TENANCY_ONLY} outside {@link TENANCY_DIR}.
 */
export function findScopeMints(file: string, content: string): ScopeHit[] {
  const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const hits: ScopeHit[] = [];
  const lines = content.split('\n');
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isPrivateIdentifier(node)) {
      const name = node.text as keyof typeof SCOPE_MINTS;
      if (TENANCY_ONLY.includes(node.text) && !file.startsWith(TENANCY_DIR)) {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line;
        hits.push({ file, line: line + 1, text: (lines[line] ?? '').trim(), rule: 'tenant-directory' });
      } else if (Object.hasOwn(SCOPE_MINTS, name) && !SCOPE_MINTS[name].includes(file)) {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line;
        hits.push({
          file,
          line: line + 1,
          text: (lines[line] ?? '').trim(),
          rule: name === 'defaultScope' ? 'default-scope' : name === 'scopeOf' ? 'scope-of' : 'directory-of',
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits;
}

async function sourceFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /\.(ts|mts|cts|js|mjs)$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
}

export async function checkTenantScope(repoRoot: string): Promise<ScopeHit[]> {
  const hits: ScopeHit[] = [];
  for (const path of await sourceFiles(join(repoRoot, SOURCE_ROOT))) {
    const file = relative(repoRoot, path).split(sep).join('/');
    const content = await readFile(path, 'utf8');
    hits.push(...findScopeMints(file, content), ...findUrlReads(file, content));
  }
  return hits;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const repoRoot = join(import.meta.dirname, '..');
  const hits = await checkTenantScope(repoRoot);
  if (hits.length === 0) {
    console.log('check:tenant-scope: no scope minted and no public URL read outside their files');
  } else {
    const WHAT = {
      'default-scope': 'defaultScope outside the files that may name it',
      'scope-of': 'scopeOf outside the files that may name it',
      'directory-of': 'directoryOf outside the files that may name it',
      'tenant-directory': 'TenantDirectory or TenantAdmin outside src/tenancy/',
      'public-url': 'a read of the configured public URL; use tenantUrl(config, request)',
      'operator-url': 'operatorPublicUrl outside main.ts and serve.ts',
      'url-without-scope': 'urlWithoutScope outside its allowed callers',
    } as const;
    for (const hit of hits) console.error(`${hit.file}:${String(hit.line)}: ${WHAT[hit.rule]}: ${hit.text}`);
    console.error('A module takes its scope, and its URL, from the request or the job loop (spec §19.5, §19.8).');
    process.exit(1);
  }
}
