/**
 * The backstop of the scope in the signature (hosted edition spec §19.8, guard 2). Its first rule: outside
 * `packages/server/src/tenancy/`, no server source calls `defaultScope(`. A route or a module that reached for
 * the default tenant would pass every one-tenant test and serve the wrong tenant in hosted mode, so the call
 * itself is refused. The one other caller the spec allows, the admin command line's self-hosted default
 * (§19.11), joins {@link ALLOWED} when Task 16 writes it; Task 17 adds the gate's other rules.
 *
 * `node scripts/check-tenant-scope.ts` prints the result and exits non-zero, listing `file:line`, on any hit.
 * Wired into `pnpm check` as `pnpm check:tenant-scope`. ESLint's config is protected, which is why this is a
 * script.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The server's source, the only tree the gate reads: tests may build any scope they like. */
export const SOURCE_ROOT = 'packages/server/src';

/** Where `defaultScope(` may appear: an entry ending in `/` covers its folder. */
export const ALLOWED: readonly string[] = ['packages/server/src/tenancy/'];

export interface ScopeHit {
  readonly file: string;
  readonly line: number;
  readonly text: string;
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
    hits.push(...findDefaultScopeCalls(file, await readFile(path, 'utf8')));
  }
  return hits;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const repoRoot = join(import.meta.dirname, '..');
  const hits = await checkTenantScope(repoRoot);
  if (hits.length === 0) {
    console.log('check:tenant-scope: no defaultScope( outside src/tenancy/');
  } else {
    for (const hit of hits)
      console.error(`${hit.file}:${String(hit.line)}: defaultScope( outside src/tenancy/: ${hit.text}`);
    console.error('A module takes its scope from the request or the job loop, never the default tenant (spec §19.8).');
    process.exit(1);
  }
}
