/**
 * Copies the browser client's build (`apps/desktop/dist-browser`, hosted edition spec §17.6) to
 * `dist/browser/`, where the host module serves it. It is not part of the server's `build`, which needs no
 * browser build: run it where one exists, after `pnpm --filter @wirebench/desktop build:browser`. The
 * Dockerfile does so, and from a checkout it is `pnpm --filter @wirebench/server copy-browser`. Without a
 * build it fails, since whoever runs it expects one.
 *
 * `node scripts/copy-browser.mjs`
 */
import { cpSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const serverDir = join(import.meta.dirname, '..');
const source = join(serverDir, '..', '..', 'apps', 'desktop', 'dist-browser');
const target = join(serverDir, 'dist', 'browser');

if (!existsSync(join(source, 'index.html'))) {
  console.error(`No browser client build in ${source}; run \`pnpm --filter @wirebench/desktop build:browser\` first.`);
  process.exit(1);
}
rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true });
