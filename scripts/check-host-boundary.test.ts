import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { findHostBoundaryViolations } from './check-host-boundary.ts';

const violationsOf = (root: string) => findHostBoundaryViolations(root).violations;

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
    expect(violationsOf(root).map((v) => [v.file, v.line, v.rule])).toEqual([
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
    expect(violationsOf(root)).toEqual([]);
  });

  it('reports top-level mutable state', () => {
    const root = fixture({
      'a.ts':
        'let x = 0;\nconst m = new Map();\nconst s = new Set<string>();\nconst l = new AsyncLocalStorage<number>();\n',
    });
    expect(violationsOf(root).map((v) => [v.line, v.rule])).toEqual([
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
    expect(violationsOf(root)).toEqual([]);
  });

  it('accepts the allowlisted names', () => {
    const root = fixture({
      'serial-session.ts': 'let loading: Promise<void> | undefined;\n',
      'script-host.ts': 'const typeCache = new WeakMap();\n',
      'window-scope.ts': 'const caller = new AsyncLocalStorage<number>();\n',
      'other.ts': 'let loading = 1;\n',
    });
    expect(violationsOf(root).map((v) => v.file)).toEqual(['apps/desktop/src/main/other.ts']);
  });

  it('finds nothing in the real tree', () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const { violations, scanned } = findHostBoundaryViolations(root);
    expect(scanned).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  });

  it('throws on a root with no host directory instead of passing', () => {
    const root = mkdtempSync(join(tmpdir(), 'host-boundary-empty-'));
    roots.push(root);
    expect(() => findHostBoundaryViolations(root)).toThrow(/no host directory/);
  });

  it('counts the files it scanned, leaving electron/ and index.ts out', () => {
    const root = fixture({ 'a.ts': '', 'sub/b.ts': '', 'electron/x.ts': '', 'index.ts': '' });
    expect(findHostBoundaryViolations(root).scanned).toBe(2);
  });

  it('reads an arrow type in a const annotation as part of the annotation', () => {
    const root = fixture({ 'a.ts': 'const m: Map<string, () => void> = new Map();\n' });
    expect(violationsOf(root).map((v) => [v.line, v.rule])).toEqual([[1, 'module-state']]);
  });

  it('reports dynamic, bare and subpath electron imports', () => {
    const root = fixture({
      'a.ts': "const e = await import('electron');\n",
      'b.ts': "import 'electron';\n",
      'c.ts': "import { app } from 'electron/main';\n",
      'd.ts': "const e = require('electron/common');\n",
    });
    expect(violationsOf(root).map((v) => [v.file, v.rule])).toEqual([
      ['apps/desktop/src/main/a.ts', 'electron-import'],
      ['apps/desktop/src/main/b.ts', 'electron-import'],
      ['apps/desktop/src/main/c.ts', 'electron-import'],
      ['apps/desktop/src/main/d.ts', 'electron-import'],
    ]);
  });

  it('reports a relative import of the electron/ directory from host code, not from inside it', () => {
    const root = fixture({
      'host/a.ts': "import { createElectronPlatform } from '../electron/electron-platform.js';\n",
      'b.ts': "import { x } from './electron/menu.js';\n",
      'c.ts': "import { y } from './electronic.js';\n",
      'electron/inner.ts': "import { z } from './menu.js';\n",
    });
    expect(violationsOf(root).map((v) => [v.file, v.rule])).toEqual([
      ['apps/desktop/src/main/b.ts', 'electron-import'],
      ['apps/desktop/src/main/host/a.ts', 'electron-import'],
    ]);
  });
});
