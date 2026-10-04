// @vitest-environment node
/**
 * The renderer imports `@wirebench/engine/detect` (the Import dialog's format sniffing), so that
 * entry must bundle for the browser. A single transitive import of `node:fs`, `node:path` or a
 * Node-only package breaks the renderer build with a `__vite-browser-external` error, and
 * `pnpm check` has no build step to catch it — this test bundles the entry the way the renderer
 * build does and fails the same way.
 */
import { resolve } from 'node:path';
import { build } from 'vite';
import { describe, expect, it } from 'vitest';

const ENTRY = resolve(import.meta.dirname, '../../../packages/engine/src/import-detect.ts');

describe('@wirebench/engine/detect', () => {
  it('bundles for the browser', async () => {
    const result = await build({
      configFile: false,
      logLevel: 'silent',
      build: {
        write: false,
        minify: false,
        lib: { entry: ENTRY, formats: ['es'], fileName: 'detect' },
      },
    });
    const outputs = Array.isArray(result) ? result : [result];
    const chunks = outputs.flatMap((output) => ('output' in output ? output.output : []));
    expect(chunks.some((chunk) => chunk.type === 'chunk' && chunk.code.includes('detectImportFormat'))).toBe(true);
  }, 60_000);
});
