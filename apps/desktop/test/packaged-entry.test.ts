/**
 * Pins that the main bundle carries the host and the wire code inside it. `@wirebench/host` and
 * `@wirebench/wire` export TypeScript sources and are devDependencies, so electron-builder never packs them:
 * a bundle that still `require`s or imports either one by name fails at launch in the packaged app.
 *
 * It needs build output, which `pnpm test` alone does not produce, so it runs only when
 * `apps/desktop/out/main/index.js` exists — locally after `pnpm build`; CI's unit job runs before any build,
 * so there it skips — and says so when it skips, as the git-backed suites do without git. The preload bundle
 * is checked the same way when it is present.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '../out');
const MAIN_ENTRY = join(OUT, 'main/index.js');
const built = existsSync(MAIN_ENTRY);

if (!built) {
  console.info(`[skip] packaged entry: no ${MAIN_ENTRY}; run \`pnpm --filter @wirebench/desktop build\` first`);
}

/** The preload bundle's file name differs by build; every `.js`/`.cjs` under out/preload is checked. */
function preloadEntries(): string[] {
  const dir = join(OUT, 'preload');
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => /\.c?js$/.test(f))
        .map((f) => join(dir, f))
    : [];
}

function expectBundled(source: string, name: string): void {
  const escaped = name.replace(/[/.]/g, '\\$&');
  expect(source).not.toMatch(new RegExp(`require\\(\\s*["']${escaped}(?:/[^"']*)?["']\\s*\\)`));
  expect(source).not.toMatch(new RegExp(`from\\s*["']${escaped}(?:/[^"']*)?["']`));
  expect(source).not.toMatch(new RegExp(`import\\(\\s*["']${escaped}(?:/[^"']*)?["']\\s*\\)`));
}

describe.skipIf(!built)('the packaged main entry', () => {
  it.each(['@wirebench/host', '@wirebench/wire'])('bundles %s instead of loading it at run time', (name) => {
    expectBundled(readFileSync(MAIN_ENTRY, 'utf8'), name);
  });

  it('bundles @wirebench/wire into the preload too', () => {
    for (const file of preloadEntries()) expectBundled(readFileSync(file, 'utf8'), '@wirebench/wire');
  });
});
