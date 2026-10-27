/**
 * Pins that the main bundle carries the host and the wire code inside it. `@wirebench/host` and
 * `@wirebench/wire` export TypeScript sources and are devDependencies, so electron-builder never packs them:
 * a bundle that still `require`s or imports either one by name fails at launch in the packaged app.
 *
 * It needs build output, which `pnpm test` alone does not produce, so it runs only when
 * `apps/desktop/out/main/index.js` exists — after `pnpm build`, which CI and every e2e run do — and says so
 * when it skips, as the git-backed suites do without git.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const MAIN_ENTRY = join(dirname(fileURLToPath(import.meta.url)), '../out/main/index.js');
const built = existsSync(MAIN_ENTRY);

if (!built) {
  console.info(`[skip] packaged entry: no ${MAIN_ENTRY}; run \`pnpm --filter @wirebench/desktop build\` first`);
}

describe.skipIf(!built)('the packaged main entry', () => {
  it.each(['@wirebench/host', '@wirebench/wire'])('bundles %s instead of loading it at run time', (name) => {
    const source = readFileSync(MAIN_ENTRY, 'utf8');
    const escaped = name.replace(/[/.]/g, '\\$&');
    expect(source).not.toMatch(new RegExp(`require\\(\\s*["']${escaped}(?:/[^"']*)?["']\\s*\\)`));
    expect(source).not.toMatch(new RegExp(`from\\s*["']${escaped}(?:/[^"']*)?["']`));
    expect(source).not.toMatch(new RegExp(`import\\(\\s*["']${escaped}(?:/[^"']*)?["']\\s*\\)`));
  });
});
