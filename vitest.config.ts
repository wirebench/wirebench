import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['packages/engine/src/**'],
      exclude: ['packages/engine/src/index.ts'],
      thresholds: {
        lines: 85,
        branches: 85,
        functions: 85,
        statements: 85,
      },
    },
    projects: [
      {
        test: {
          name: 'engine-unit',
          include: ['packages/engine/test/unit/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'engine-integration',
          include: ['packages/engine/test/integration/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'engine-interop',
          include: ['packages/engine/test/interop/**/*.test.ts'],
        },
      },
    ],
  },
});
