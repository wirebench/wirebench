// @ts-check
import tseslint from 'typescript-eslint';

/** The Monaco entry point every other module must go through; it is the one file allowed a bare import. */
const MONACO_CORE = 'apps/desktop/src/renderer/editor/monaco-core.ts';

/** Bans a bare `import 'monaco-editor'`. */
const MONACO_PATH = {
  name: 'monaco-editor',
  allowTypeImports: true,
  message: 'import Monaco through renderer/editor/monaco-core.ts; a bare import re-adds every worker',
};

/**
 * Bans every `@wirebench/engine` import bar the browser-safe subpaths. A regex, not a `group`:
 * gitignore-style globs cannot express "this package and every subpath of it *except* these".
 *
 * `/xml` carries the parser Monaco's XML language service needs; `/rest` carries the URL helpers the
 * REST editor's query table and URL field share with the send path — the one thing that must not be
 * reimplemented in the renderer, since two sets of escaping rules would eventually disagree about
 * what is being sent; `/grpc` carries the pure method-kind and target rules; `/detect` carries
 * pure-text format detection for the unified import dialog; `/json` carries the cursor analysis
 * Monaco's JSON completion provider runs on every keystroke, which is why it is not an IPC call.
 * All of them are pure text code with no Node dependency.
 */
const ENGINE_PATTERN = {
  regex: '^@wirebench/engine(?!/(xml|rest|grpc|ws|json|detect)$)(/.*)?$',
  message:
    'the renderer reaches the engine over IPC; only the browser-safe @wirebench/engine/xml, /rest, /grpc, /ws, /json, and /detect subpaths may be imported (ADR-0002)',
};

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/dist-test/**',
      '**/out/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '.superpowers/**',
      '**/fixtures/**',
      'docs-site/.astro/**',
      // Its astro:content types are generated into .astro/ by an Astro build or `astro sync`, which
      // the lint job never runs, so typed rules would see every import as unresolved.
      'docs-site/src/content.config.ts',
    ],
  },
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['vitest.config.ts'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // Monaco may only be pulled in at runtime through `editor/monaco-core.ts`, which imports the
    // trimmed set of feature modules. A bare `import 'monaco-editor'` anywhere else re-registers
    // every bundled language and the four language-service workers (17 MB of build output), and
    // nothing else would catch it until the renderer bundle had already doubled. Type-only
    // imports are fine: they disappear at build time.
    files: ['apps/desktop/**/*.{ts,tsx,mts,cts}'],
    ignores: [MONACO_CORE],
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', { paths: [MONACO_PATH] }],
    },
  },
  {
    // ADR-0002 put the engine in the main process: the renderer talks to it over IPC, never by
    // importing it. The exceptions are the two browser-safe subpaths `@wirebench/engine/xml` and
    // `@wirebench/engine/rest` (see ENGINE_PATTERN), so the ban is expressed as "the engine, except
    // those subpaths" rather than as a convention nobody can enforce. The
    // Monaco rule from the block above is repeated here because a second `no-restricted-imports`
    // entry replaces the first rather than merging with it.
    files: ['apps/desktop/src/renderer/**/*.{ts,tsx,mts,cts}'],
    ignores: [MONACO_CORE],
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', { paths: [MONACO_PATH], patterns: [ENGINE_PATTERN] }],
    },
  },
  {
    // `monaco-core.ts` is exempt from the Monaco rule alone — it is the file the rest of the
    // renderer imports Monaco through. It is renderer code like any other, so the engine ban
    // still applies to it, and it gets its own block because exempting it from the block above
    // would have exempted it from both rules at once.
    files: [MONACO_CORE],
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', { patterns: [ENGINE_PATTERN] }],
    },
  },
  {
    files: ['packages/engine/**/*.{ts,tsx,mts,cts}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'electron', message: 'engine must stay free of Electron/React' },
            { name: 'react', message: 'engine must stay free of Electron/React' },
            { name: 'react-dom', message: 'engine must stay free of Electron/React' },
            { name: '@wirebench/desktop', message: 'engine must stay free of Electron/React' },
          ],
        },
      ],
    },
  },
);
