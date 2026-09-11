// @ts-check
import tseslint from 'typescript-eslint';

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
    ignores: ['apps/desktop/src/renderer/editor/monaco-core.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'monaco-editor',
              allowTypeImports: true,
              message: 'import Monaco through renderer/editor/monaco-core.ts; a bare import re-adds every worker',
            },
          ],
        },
      ],
    },
  },
  {
    // ADR-0002 put the engine in the main process: the renderer talks to it over IPC, never by
    // importing it. The one exception is the browser-safe `@wirebench/engine/xml` subpath (the
    // Monaco XML language service needs the same parser main uses), so the ban is expressed as
    // "the engine, except that subpath" rather than as a convention nobody can enforce. The
    // Monaco rule from the block above is repeated here because a second `no-restricted-imports`
    // entry replaces the first rather than merging with it.
    files: ['apps/desktop/src/renderer/**/*.{ts,tsx,mts,cts}'],
    ignores: ['apps/desktop/src/renderer/editor/monaco-core.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'monaco-editor',
              allowTypeImports: true,
              message: 'import Monaco through renderer/editor/monaco-core.ts; a bare import re-adds every worker',
            },
          ],
          patterns: [
            {
              // A regex, not a `group`: gitignore-style globs cannot express "this package and
              // every subpath of it *except* one".
              regex: '^@wirebench/engine(?!/xml$)(/.*)?$',
              message:
                'the renderer reaches the engine over IPC; only the browser-safe @wirebench/engine/xml subpath may be imported (ADR-0002)',
            },
          ],
        },
      ],
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
