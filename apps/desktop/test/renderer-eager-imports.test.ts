// @vitest-environment node
/**
 * The renderer CSP trap, as a test. The renderer runs without `'unsafe-eval'`, and zod 4 probes
 * `new Function('')` when it builds an object schema. `main.tsx` turns that probe off with
 * `z.config({ jitless: true })`, but only after its static imports have run, so a module that builds a
 * schema at load time and is reached eagerly from `main.tsx` trips the CSP, and the e2e console gate
 * fails every spec. The schema modules below are `import type` only on that chain; a value the renderer
 * needs lives in a zod-free module (`shared/ssh-defaults.ts`, `features/team/roles.ts`, ...).
 *
 * Walks the static import graph from `main.tsx`: `import`/`export ... from` statements, skipping
 * `import type`, `export type` and imports whose every specifier is an inline `type`. A dynamic
 * `import()` (and so `lazy()`) is a boundary that runs after `main.tsx`, so it is not followed.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/** A path relative to `from`, with `/` separators on every platform so reports compare equal. */
const posixRelative = (from: string, to: string): string => relative(from, to).split(sep).join('/');

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
/** Where `@shared/` (and `@wirebench/wire/`) resolve: the wire package's sources. */
const wireSrcDir = join(repoRoot, 'packages/wire/src');

/** Module files (relative to the wire sources) that build zod schemas at load time. */
const FORBIDDEN_FILES = [
  'ipc.ts',
  'wire-types.ts',
  'wire-base.ts',
  'ssh-wire.ts',
  'sftp-wire.ts',
  'runner-wire.ts',
  ...['soap', 'rest', 'graphql', 'grpc', 'ws', 'mcp'].flatMap((kind) => [
    `kinds/${kind}/wire.ts`,
    `kinds/${kind}/channels.ts`,
  ]),
];
/** Bare specifiers whose value import must not reach the renderer's eager chain. */
const FORBIDDEN_PACKAGES = ['@wirebench/engine'];

interface Violation {
  readonly from: string;
  readonly to: string;
}

/** The value (non type-only) static import specifiers of one source file. */
function valueImports(fileName: string, text: string): string[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);
  const specifiers: string[] = [];
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (clause !== undefined) {
        if (clause.isTypeOnly) continue;
        const bindings = clause.namedBindings;
        const allInlineTypes =
          clause.name === undefined &&
          bindings !== undefined &&
          ts.isNamedImports(bindings) &&
          bindings.elements.length > 0 &&
          bindings.elements.every((element) => element.isTypeOnly);
        if (allInlineTypes) continue;
      }
      if (ts.isStringLiteral(statement.moduleSpecifier)) specifiers.push(statement.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly || statement.moduleSpecifier === undefined) continue;
      const clause = statement.exportClause;
      if (
        clause !== undefined &&
        ts.isNamedExports(clause) &&
        clause.elements.length > 0 &&
        clause.elements.every((element) => element.isTypeOnly)
      ) {
        continue;
      }
      if (ts.isStringLiteral(statement.moduleSpecifier)) specifiers.push(statement.moduleSpecifier.text);
    }
  }
  return specifiers;
}

/**
 * Resolves a relative, `@shared/` or `@wirebench/wire/` specifier to a source file; `undefined` for any
 * other package or an asset.
 */
function resolveLocal(from: string, specifier: string, sharedDir: string): string | undefined {
  let base: string;
  if (specifier.startsWith('@shared/')) base = join(sharedDir, specifier.slice('@shared/'.length));
  else if (specifier.startsWith('@wirebench/wire/')) base = join(sharedDir, specifier.slice('@wirebench/wire/'.length));
  else if (specifier.startsWith('.')) base = resolve(dirname(from), specifier);
  else return undefined;
  const stem = base.replace(/\.(js|jsx|ts|tsx)$/, '');
  for (const candidate of [`${stem}.ts`, `${stem}.tsx`, join(stem, 'index.ts'), join(stem, 'index.tsx')]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined; // CSS, `?worker` and other assets
}

/**
 * Every eager value import of a forbidden module reachable from `entry`, with paths reported relative to
 * `root`. `sharedDir` is where the wire modules (and so {@link FORBIDDEN_FILES}) live.
 */
function eagerViolations(entry: string, root: string, sharedDir: string): Violation[] {
  const forbidden = new Set(FORBIDDEN_FILES.map((file) => join(sharedDir, file)));
  const seen = new Set<string>();
  const queue = [entry];
  const violations: Violation[] = [];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of valueImports(file, readFileSync(file, 'utf-8'))) {
      if (FORBIDDEN_PACKAGES.includes(specifier)) {
        violations.push({ from: posixRelative(root, file), to: specifier });
        continue;
      }
      const target = resolveLocal(file, specifier, sharedDir);
      if (target === undefined) continue;
      if (forbidden.has(target)) {
        violations.push({ from: posixRelative(root, file), to: posixRelative(root, target) });
        continue;
      }
      queue.push(target);
    }
  }
  return violations;
}

/** Every `.ts` file under `dir`, relative to `root`, `/`-separated. */
function filesUnder(dir: string, root: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts'))
    .map((file) => posixRelative(root, join(dir, file)));
}

describe('renderer eager imports', () => {
  it('names only wire modules that exist, so a moved file fails here instead of going unchecked', () => {
    expect(FORBIDDEN_FILES.filter((file) => !existsSync(join(wireSrcDir, file)))).toEqual([]);
  });

  it('lists every file under the wire kinds/ that imports zod or a listed module as forbidden', () => {
    const forbidden = new Set(FORBIDDEN_FILES);
    const unlisted = filesUnder(join(wireSrcDir, 'kinds'), wireSrcDir).filter((file) => {
      const path = join(wireSrcDir, file);
      const builds = valueImports(path, readFileSync(path, 'utf-8')).some((specifier) => {
        if (specifier === 'zod') return true;
        const target = resolveLocal(path, specifier, wireSrcDir);
        return target !== undefined && forbidden.has(posixRelative(wireSrcDir, target));
      });
      return builds && !forbidden.has(file);
    });
    expect(unlisted).toEqual([]);
  });

  it('reach no zod-schema module and no bare @wirebench/engine as a value from main.tsx', () => {
    expect(eagerViolations(join(repoRoot, 'apps/desktop/src/renderer/main.tsx'), repoRoot, wireSrcDir)).toEqual([]);
  });

  it('tells value imports from type-only ones and stops at dynamic import()', () => {
    const root = mkdtempSync(join(tmpdir(), 'wirebench-eager-imports-'));
    try {
      const files: Record<string, string> = {
        'shared/ssh-wire.ts': "import { z } from 'zod';\nexport const s = z.object({});\nexport type T = 1;\n",
        'shared/wire-types.ts': 'export const w = 1;\nexport type W = 1;\n',
        'shared/ipc.ts': 'export const i = 1;\n',
        'shared/plain.ts': 'export const p = 1;\n',
        'renderer/main.tsx':
          "import type { T } from '../shared/ssh-wire.js';\nimport { type W } from '@shared/wire-types.js';\n" +
          "export type { T as U } from '../shared/ssh-wire.js';\nimport { p } from '@shared/plain.js';\n" +
          "import './bad.js';\nconst later = () => import('./lazy.js');\nexport const x = [p, later];\n",
        'renderer/bad.ts':
          "export { s } from '../shared/ssh-wire.js';\nimport { type W, w } from '../shared/wire-types.js';\n" +
          "import { run } from '@wirebench/engine';\nimport { formatXml } from '@wirebench/engine/xml';\n",
        'renderer/lazy.tsx': "import { i } from '../shared/ipc.js';\nexport default i;\n",
      };
      for (const [file, text] of Object.entries(files)) {
        mkdirSync(dirname(join(root, file)), { recursive: true });
        writeFileSync(join(root, file), text);
      }
      expect(eagerViolations(join(root, 'renderer/main.tsx'), root, join(root, 'shared'))).toEqual([
        { from: 'renderer/bad.ts', to: 'shared/ssh-wire.ts' },
        { from: 'renderer/bad.ts', to: 'shared/wire-types.ts' },
        { from: 'renderer/bad.ts', to: '@wirebench/engine' },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
