import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractDocPaths, findMissingPaths, isRepoPath } from './check-doc-paths.ts';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const docPath = fileURLToPath(new URL('../docs/success-criteria.md', import.meta.url));

describe('extractDocPaths', () => {
  it('pulls a plain backticked repo path', () => {
    expect(extractDocPaths('see `packages/engine/test/unit/import.test.ts` for proof')).toEqual([
      'packages/engine/test/unit/import.test.ts',
    ]);
  });

  it('expands a single brace group into one path per alternative', () => {
    expect(extractDocPaths('`apps/desktop/test/{a,b,c}.test.ts`')).toEqual([
      'apps/desktop/test/a.test.ts',
      'apps/desktop/test/b.test.ts',
      'apps/desktop/test/c.test.ts',
    ]);
  });

  it('follows a markdown link to its target, not its display text', () => {
    expect(extractDocPaths('[`ci.yml`](../.github/workflows/ci.yml)')).toEqual(['../.github/workflows/ci.yml']);
  });

  it('ignores an external link', () => {
    expect(extractDocPaths('[`keepachangelog`](https://keepachangelog.com/en/1.1.0/)')).toEqual([]);
  });

  it('ignores backticked spans with no path separator (commands, prose terms)', () => {
    expect(extractDocPaths('run `pnpm check`, or note `xsi:type` and `WIREBENCH_NETWORK_TESTS=1`')).toEqual([]);
  });

  it('keeps a trailing directory glob as the directory to check', () => {
    expect(extractDocPaths('`packages/engine/test/unit/wss/**`')).toEqual(['packages/engine/test/unit/wss']);
    expect(extractDocPaths('`packages/engine/test/unit/soap/mime/*`')).toEqual(['packages/engine/test/unit/soap/mime']);
  });
});

describe('findMissingPaths', () => {
  it('reports a path that does not exist under the given root, relative to the doc', () => {
    expect(findMissingPaths(['no/such/file.ts'], repoRoot, 'docs/success-criteria.md')).toEqual(['no/such/file.ts']);
  });

  it('reports nothing for a path that exists', () => {
    expect(findMissingPaths(['package.json'], repoRoot, 'docs/success-criteria.md')).toEqual([]);
  });

  it('resolves a relative link against the directory the doc lives in', () => {
    // success-criteria.md lives in docs/, so ../README.md should resolve to the repo root README.
    expect(findMissingPaths(['../README.md'], repoRoot, 'docs/success-criteria.md')).toEqual([]);
  });
});

describe('docs/success-criteria.md', () => {
  it('has no dangling backticked repo paths', async () => {
    const markdown = await readFile(docPath, 'utf-8');
    const paths = extractDocPaths(markdown);
    expect(paths.length).toBeGreaterThan(10);
    expect(findMissingPaths(paths, repoRoot, 'docs/success-criteria.md')).toEqual([]);
  });
});

describe('isRepoPath', () => {
  it('accepts spans that start at a repo top-level folder', () => {
    expect(isRepoPath('apps/desktop/src/shared/command-catalog.ts')).toBe(true);
    expect(isRepoPath('docs/ws-i-assertions.md')).toBe(true);
    expect(isRepoPath('.github/workflows/docs.yml')).toBe(true);
  });

  it('ignores user-facing spans that merely contain a slash', () => {
    expect(isRepoPath('application/json')).toBe(false);
    expect(isRepoPath('~/Library/Application Support/Wirebench')).toBe(false);
    expect(isRepoPath('https://example.com/a')).toBe(false);
    expect(isRepoPath('/wirebench/guides/rest/')).toBe(false);
  });
});

describe('extractDocPaths with fenced code blocks', () => {
  it('skips fenced examples, indented ones included, and still reads the spans after them', () => {
    const markdown = [
      '```json',
      '{ "a": `b` }',
      '```',
      '',
      '1. Step',
      '   ```',
      '   `not/a/citation`',
      '   ```',
      '',
      'See `apps/desktop/src/shared/command-catalog.ts`.',
    ].join('\n');
    expect(extractDocPaths(markdown)).toEqual(['apps/desktop/src/shared/command-catalog.ts']);
  });
});
