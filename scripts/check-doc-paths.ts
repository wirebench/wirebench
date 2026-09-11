/**
 * Verifies that every repo path `docs/success-criteria.md` cites, as evidence for a success
 * criterion, still exists — so a renamed or deleted test file goes stale loudly instead of
 * silently.
 *
 * Two shapes of citation are recognised:
 *  - A markdown link `[\`text\`](target)`: `target` is checked (its display text is not — it
 *    is free-form prose, e.g. `ci.yml` standing in for `../.github/workflows/ci.yml`).
 *  - A bare backticked span containing a path separator, e.g.
 *    `` `packages/engine/test/unit/import.test.ts` ``. A single `{a,b,c}` brace group in such a
 *    span is expanded into one path per alternative. A span ending `/**` or `/*` is treated as a
 *    glob over a directory, and only that directory is checked.
 *
 * `node scripts/check-doc-paths.ts` prints the result and exits non-zero if anything is
 * missing. Wired into `pnpm check` as `pnpm check:doc-paths`.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const DOC_RELATIVE_PATH = 'docs/success-criteria.md';

/** Expands the single `{a,b,c}` brace group in `path`, if any, into one path per alternative. */
function expandBraces(path: string): string[] {
  const match = /\{([^{}]+)\}/.exec(path);
  if (!match) {
    return [path];
  }
  const [whole, group] = match;
  return group!.split(',').map((alternative) => path.replace(whole, alternative));
}

/** Strips a trailing `/**` or `/*` glob so only the directory it globs over is checked. */
function stripTrailingGlob(path: string): string {
  return path.replace(/\/\*{1,2}$/, '');
}

/** True for a backticked span worth treating as a repo path: it names a location, not a term. */
function looksLikePath(candidate: string): boolean {
  return candidate.includes('/') && !candidate.includes(' ');
}

/**
 * Pulls every repo path cited in `markdown`, expanding brace groups and stripping trailing
 * globs. Pure — does not touch the filesystem.
 */
export function extractDocPaths(markdown: string): string[] {
  const paths: string[] = [];
  const consumed = new Set<number>();

  // Markdown links: `[`text`](target)`. Use the target, skip external (http/https) links.
  const linkPattern = /\[`[^`]*`\]\(([^)]+)\)/g;
  for (const match of markdown.matchAll(linkPattern)) {
    consumed.add(match.index);
    const target = match[1]!.split('#')[0]!;
    if (target.length === 0 || /^https?:\/\//.test(target)) {
      continue;
    }
    paths.push(target);
  }

  // Bare backtick spans not already consumed as part of a link's display text.
  const spanPattern = /`([^`]+)`/g;
  for (const match of markdown.matchAll(spanPattern)) {
    // Part of `[`text`](...)`? The link regex above starts one character earlier (`[`).
    if (consumed.has(match.index - 1)) {
      continue;
    }
    const candidate = match[1]!;
    if (!looksLikePath(candidate)) {
      continue;
    }
    for (const expanded of expandBraces(candidate)) {
      paths.push(stripTrailingGlob(expanded));
    }
  }

  return paths;
}

/**
 * Resolves each of `paths` against the directory `docRelativePath` lives in (paths in a doc are
 * either repo-root-relative or relative to that doc, both handled the same way by `resolve`) and
 * returns the ones that do not exist under `repoRoot`.
 */
export function findMissingPaths(paths: readonly string[], repoRoot: string, docRelativePath: string): string[] {
  const docDir = join(repoRoot, dirname(docRelativePath));
  return paths.filter((path) => !existsSync(resolve(docDir, path)) && !existsSync(resolve(repoRoot, path)));
}

async function main(): Promise<void> {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const markdown = await readFile(join(repoRoot, DOC_RELATIVE_PATH), 'utf-8');
  const paths = extractDocPaths(markdown);
  const missing = findMissingPaths(paths, repoRoot, DOC_RELATIVE_PATH);

  if (missing.length === 0) {
    process.stdout.write(`${DOC_RELATIVE_PATH}: all ${String(paths.length)} cited paths exist\n`);
    return;
  }
  process.stderr.write(
    `${DOC_RELATIVE_PATH} cites ${String(missing.length)} path(s) that do not exist:\n${missing
      .map((path) => `  - ${path}`)
      .join('\n')}\n`,
  );
  process.exitCode = 1;
}

// Only run when executed directly (`node scripts/check-doc-paths.ts`), not when the test file
// imports the pure functions above.
if (process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], 'file:').href) {
  await main();
}
