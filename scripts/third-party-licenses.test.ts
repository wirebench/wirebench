import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderThirdPartyLicenses } from './third-party-licenses.js';

const target = fileURLToPath(new URL('../THIRD-PARTY-LICENSES.md', import.meta.url));
const rendererDir = fileURLToPath(new URL('../apps/desktop/src/renderer', import.meta.url));

/**
 * Import specifiers that name no npm package: relative paths, this repo's own workspace
 * packages, Node built-ins, and the `@shared` path alias the desktop tsconfig and
 * `electron.vite.config.ts` both map to `apps/desktop/src/shared`.
 */
const NOT_A_PACKAGE = [/^\./, /^@wirebench\//, /^node:/, /^@shared\//];

/** Every `.ts`/`.tsx` file under `dir`, recursively. */
async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(path)));
    } else if (/\.tsx?$/.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

/**
 * The npm package name a specifier refers to: the scope and name for a scoped package, the
 * first segment otherwise, with any Vite `?worker`/asset query stripped first.
 */
export function packageNameOf(specifier: string): string {
  const [path] = specifier.split('?');
  const segments = path!.split('/');
  return path!.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]!;
}

/**
 * Blanks out `//` and comment blocks, keeping the source's length and line structure so the
 * import patterns below still match at the right offsets. String and template literals are
 * tracked so a `//` inside one — a URL, say — is not mistaken for the start of a comment.
 *
 * Prose is not code: a comment reading `the "Resolves from" column` once matched the `from '…'`
 * pattern below and read the sentence after it as a package name, failing this suite for a
 * wording choice. Comments are stripped before the patterns run so prose can say anything.
 */
export function stripComments(source: string): string {
  let out = '';
  let index = 0;
  let quote: string | undefined;
  while (index < source.length) {
    const char = source[index]!;
    const next = source[index + 1];
    if (quote !== undefined) {
      out += char;
      if (char === '\\') {
        out += source[index + 1] ?? '';
        index += 2;
        continue;
      }
      if (char === quote) {
        quote = undefined;
      }
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      out += char;
      index += 1;
      continue;
    }
    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') {
        out += ' ';
        index += 1;
      }
      continue;
    }
    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      const stop = end === -1 ? source.length : end + 2;
      for (let cursor = index; cursor < stop; cursor += 1) {
        out += source[cursor] === '\n' ? '\n' : ' ';
      }
      index = stop;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

/**
 * The three import forms a module can name a package with: `… from '…'` (static, including a
 * multi-line clause and `export … from`), a bare `import '…'` side effect at the start of a
 * line, and a dynamic `import('…')`. The lookbehind on the first keeps a quoted `'from'` in
 * ordinary data — a label table, say — from reading as an import clause.
 */
const IMPORT_PATTERNS = [
  /(?<!['"\w$])from\s*['"]([^'"]+)['"]/g,
  /^\s*import\s+['"]([^'"]+)['"]/gm,
  /\bimport\(\s*['"]([^'"]+)['"]/g,
];

/** Every bare package name imported by `source`, whatever the import form. */
export function bareImportsOf(source: string): string[] {
  const names = new Set<string>();
  const code = stripComments(source);
  for (const pattern of IMPORT_PATTERNS) {
    for (const match of code.matchAll(pattern)) {
      const specifier = match[1]!;
      if (NOT_A_PACKAGE.some((candidate) => candidate.test(specifier))) {
        continue;
      }
      names.add(packageNameOf(specifier));
    }
  }
  return [...names];
}

describe('THIRD-PARTY-LICENSES.md', () => {
  it('matches what the installed dependency tree actually contains', async () => {
    const committed = await readFile(target, 'utf-8');
    expect(committed).toBe(await renderThirdPartyLicenses());
  });

  it('attributes the packages a reader would look for first', async () => {
    const committed = await readFile(target, 'utf-8');
    for (const name of ['electron', 'monaco-editor', 'react', 'undici', 'xmllint-wasm']) {
      expect(committed).toContain(`| \`${name}\` |`);
    }
    // A package whose license could not be determined is an attribution gap, not a detail.
    expect(committed).not.toContain('| UNKNOWN |');
  });

  it('attributes the server image dependencies', async () => {
    const rendered = await renderThirdPartyLicenses();
    for (const name of ['fastify', 'pg']) {
      expect(rendered).toMatch(new RegExp(`^## ${name}@|\\| ${name} \\|`, 'm'));
    }
  });

  it('attributes every third-party package the renderer bundle imports', async () => {
    const committed = await readFile(target, 'utf-8');
    const files = await sourceFiles(rendererDir);
    expect(files.length).toBeGreaterThan(0);

    const imported = new Set<string>();
    for (const file of files) {
      for (const name of bareImportsOf(await readFile(file, 'utf-8'))) {
        imported.add(name);
      }
    }
    expect(imported.size).toBeGreaterThan(0);

    // Every one of them ships in the renderer bundle, so every one of them needs a row.
    const unattributed = [...imported].filter((name) => !committed.includes(`| \`${name}\` |`)).sort();
    expect(unattributed).toEqual([]);
  });
});

describe('bareImportsOf', () => {
  it('ignores relative, workspace, built-in and aliased specifiers', () => {
    const source = [
      "import { a } from './a.js';",
      "import { b } from '@wirebench/engine/xml';",
      "import { c } from 'node:path';",
      "import { d } from '@shared/commands.js';",
    ].join('\n');
    expect(bareImportsOf(source)).toEqual([]);
  });

  it('ignores a quoted phrase ending in "from" inside a comment', () => {
    // The exact shape that once failed this suite: prose in a comment, not an import clause.
    const source = [
      '// `shadows X` in the "Resolves from" column is a promise the app has to keep.',
      '/* The "Resolves from" column makes the opposite choice, because it answers',
      '   a different question. */',
      "import { real } from 'immer';",
    ].join('\n');
    expect(bareImportsOf(source)).toEqual(['immer']);
  });

  it('does not mistake a comment marker inside a string for a comment', () => {
    const source = ["const docs = 'https://example.com/x';", "import { real } from 'react';"].join('\n');
    expect(bareImportsOf(source)).toEqual(['react']);
  });

  it('reduces a subpath, a scope and a Vite query to the package name', () => {
    const source = [
      "import 'monaco-editor/editor/editor.worker.js?worker';",
      "import { createRoot } from 'react-dom/client';",
      "import * as Dialog from '@radix-ui/react-dialog';",
      "const lazy = await import('immer');",
    ].join('\n');
    expect(bareImportsOf(source).sort()).toEqual(['@radix-ui/react-dialog', 'immer', 'monaco-editor', 'react-dom']);
  });
});
