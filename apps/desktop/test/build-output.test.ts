/**
 * Pins the shape of the renderer build: no Monaco language-service workers, and a total
 * JavaScript size under the budget.
 *
 * These assertions need build output, which `pnpm test` alone does not produce, so the file
 * runs only when `apps/desktop/out/renderer` exists — after `pnpm build`, which is what CI and
 * every e2e run do. The same assertions run unconditionally in the e2e global setup
 * (`e2e/global-setup.ts`), which already requires a built app, so a regression cannot slip
 * through on the strength of a missing build alone.
 */
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  FORBIDDEN_WORKER_ASSETS,
  RENDERER_JS_BUDGET_BYTES,
  RENDERER_OUT_DIR,
  inspectRendererAssets,
} from './helpers/renderer-assets.js';

const built = existsSync(RENDERER_OUT_DIR);

describe.skipIf(!built)('renderer build output', () => {
  it('ships none of the Monaco language-service workers', () => {
    const assets = inspectRendererAssets();
    expect(assets.files.length).toBeGreaterThan(0);
    expect(assets.forbidden, `forbidden assets: ${assets.forbidden.join(', ')}`).toEqual([]);
    // The editor worker itself must stay: it is the one Monaco worker the XML editor uses.
    expect(assets.files.some((file) => file.includes('editor.worker'))).toBe(true);
  });

  it(`keeps renderer JavaScript under ${RENDERER_JS_BUDGET_BYTES / 1024 / 1024} MB`, () => {
    const { totalJsBytes } = inspectRendererAssets();
    console.info(`[perf] renderer JS: ${(totalJsBytes / 1024 / 1024).toFixed(1)} MB`);
    expect(totalJsBytes).toBeGreaterThan(0);
    expect(totalJsBytes).toBeLessThan(RENDERER_JS_BUDGET_BYTES);
  });

  it('names every worker it forbids', () => {
    // Guards the list itself against an accidental empty/typo'd entry, which would make the
    // assertion above vacuously true.
    expect(FORBIDDEN_WORKER_ASSETS.every((name) => name.endsWith('.worker'))).toBe(true);
  });
});
