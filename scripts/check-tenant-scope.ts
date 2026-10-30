/**
 * The backstop of the scope in the signature (hosted edition spec §19.8, guard 2). Outside
 * `packages/server/src/tenancy/`:
 *
 * - **No `defaultScope(`.** A route or a module that reached for the default tenant would pass every one-tenant
 *   test and serve the wrong tenant in hosted mode, so the call itself is refused. The one other caller the
 *   spec allows, the admin command line's self-hosted default (§19.11), joins {@link ALLOWED} when Task 16
 *   writes it.
 * - **No read of the configured public URL** (§19.5): no `.publicUrl`, `['publicUrl']`, `'publicUrl'` (a
 *   `Pick` that would carry it) or destructuring of it, outside `config.ts`. A module takes the tenant's URL
 *   from `tenantUrl(config, request)`, so it cannot keep a copy made at registration. `operatorPublicUrl` is
 *   the operator's own output, in `main.ts` and `serve.ts` only, and `urlWithoutScope`, the URL where no
 *   scope exists yet, has the callers {@link URL_WITHOUT_SCOPE_ALLOWED} names.
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

/** Where `defaultScope(` may appear: an entry ending in `/` covers its folder. */
export const ALLOWED: readonly string[] = ['packages/server/src/tenancy/'];

/** Where the configured URL may be read: the config itself, and `src/tenancy/` (through {@link isAllowed}). */
export const PUBLIC_URL_ALLOWED: readonly string[] = ['packages/server/src/config.ts'];

/** The operator's own output (spec §19.5). */
export const OPERATOR_URL_ALLOWED: readonly string[] = ['packages/server/src/main.ts', 'packages/server/src/serve.ts'];

/**
 * Where nothing gives a scope yet (`tenancy/urls.ts`): the admin command line until Task 16, the scheduler's
 * alert links until Task 13, and the server-wide SAML provider until slice 7.
 */
export const URL_WITHOUT_SCOPE_ALLOWED: readonly string[] = [
  'packages/server/src/identity/cli.ts',
  'packages/server/src/schedules/settings.ts',
  'packages/server/src/sso/module.ts',
];

export interface ScopeHit {
  readonly file: string;
  readonly line: number;
  readonly text: string;
  /** Which rule it broke; absent for `defaultScope(`. */
  readonly rule?: 'public-url' | 'operator-url' | 'url-without-scope';
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
    if (ts.isIdentifier(node)) {
      if (node.text === 'operatorPublicUrl' && !OPERATOR_URL_ALLOWED.includes(file)) hit(node, 'operator-url');
      if (node.text === 'urlWithoutScope' && !URL_WITHOUT_SCOPE_ALLOWED.includes(file)) hit(node, 'url-without-scope');
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits;
}

export function isAllowed(path: string): boolean {
  return ALLOWED.some((entry) => (entry.endsWith('/') ? path.startsWith(entry) : path === entry));
}

/** The `defaultScope(` calls in `content`, skipping lines that are only a comment. */
export function findDefaultScopeCalls(file: string, content: string): ScopeHit[] {
  const hits: ScopeHit[] = [];
  for (const [index, text] of content.split('\n').entries()) {
    const trimmed = text.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
    if (/\bdefaultScope\s*\(/.test(text)) hits.push({ file, line: index + 1, text: trimmed });
  }
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
    if (isAllowed(file)) continue;
    const content = await readFile(path, 'utf8');
    hits.push(...findDefaultScopeCalls(file, content), ...findUrlReads(file, content));
  }
  return hits;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const repoRoot = join(import.meta.dirname, '..');
  const hits = await checkTenantScope(repoRoot);
  if (hits.length === 0) {
    console.log('check:tenant-scope: no defaultScope( and no public URL read outside src/tenancy/');
  } else {
    const WHAT = {
      'public-url': 'a read of the configured public URL; use tenantUrl(config, request)',
      'operator-url': 'operatorPublicUrl outside main.ts and serve.ts',
      'url-without-scope': 'urlWithoutScope outside its allowed callers',
    } as const;
    for (const hit of hits)
      console.error(
        `${hit.file}:${String(hit.line)}: ${hit.rule === undefined ? 'defaultScope( outside src/tenancy/' : WHAT[hit.rule]}: ${hit.text}`,
      );
    console.error('A module takes its scope, and its URL, from the request or the job loop (spec §19.5, §19.8).');
    process.exit(1);
  }
}
