import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findHostBoundaryViolations } from './check-host-boundary.ts';

const roots: string[] = [];

/** A fixture repo with `files` (paths relative to `apps/desktop/src/main`). */
function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'host-boundary-'));
  roots.push(root);
  for (const [file, text] of Object.entries(files)) {
    const path = join(root, 'apps/desktop/src/main', file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text, 'utf8');
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('findHostBoundaryViolations', () => {
  it('reports an electron import, in every spelling', () => {
    const root = fixture({
      'a.ts': "import { app } from 'electron';\n",
      'b.ts': "import type { App } from 'electron';\n",
      'c.ts': "const e = require('electron');\n",
    });
    expect(findHostBoundaryViolations(root).map((v) => [v.file, v.line, v.rule])).toEqual([
      ['apps/desktop/src/main/a.ts', 1, 'electron-import'],
      ['apps/desktop/src/main/b.ts', 1, 'electron-import'],
      ['apps/desktop/src/main/c.ts', 1, 'electron-import'],
    ]);
  });

  it('leaves electron/ and index.ts alone', () => {
    const root = fixture({
      'electron/x.ts': "import { app } from 'electron';\n",
      'index.ts': "import { app } from 'electron';\n",
    });
    expect(findHostBoundaryViolations(root)).toEqual([]);
  });

  it('reports top-level mutable state', () => {
    const root = fixture({
      'a.ts':
        'let x = 0;\nconst m = new Map();\nconst s = new Set<string>();\nconst l = new AsyncLocalStorage<number>();\n',
    });
    expect(findHostBoundaryViolations(root).map((v) => [v.line, v.rule])).toEqual([
      [1, 'module-state'],
      [2, 'module-state'],
      [3, 'module-state'],
      [4, 'module-state'],
    ]);
  });

  it('accepts read-only constants and state inside a function', () => {
    const root = fixture({
      'a.ts': [
        "const S: ReadonlySet<string> = new Set(['a']);",
        "const M: ReadonlyMap<string, number> = new Map([['a', 1]]);",
        'export function f(): number {',
        '  let n = 0;',
        '  const cache = new Map();',
        '  return n + cache.size;',
        '}',
        '',
      ].join('\n'),
    });
    expect(findHostBoundaryViolations(root)).toEqual([]);
  });

  it('accepts the allowlisted names', () => {
    const root = fixture({
      'serial-session.ts': 'let loading: Promise<void> | undefined;\n',
      'script-host.ts': 'const typeCache = new WeakMap();\n',
      'window-scope.ts': 'const caller = new AsyncLocalStorage<number>();\n',
      'other.ts': 'let loading = 1;\n',
    });
    expect(findHostBoundaryViolations(root).map((v) => v.file)).toEqual(['apps/desktop/src/main/other.ts']);
  });

  it('finds nothing in the real tree', () => {
    const root = new URL('..', import.meta.url).pathname;
    expect(findHostBoundaryViolations(root)).toEqual([]);
  });
});
