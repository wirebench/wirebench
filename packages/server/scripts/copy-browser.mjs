/**
 * Copies the browser client's build (`apps/desktop/dist-browser`, hosted edition spec §17.6) to
 * `dist/browser/`, where the host module serves it. The desktop's `build:browser` makes it; this step does
 * not run that build. Without one it warns and leaves `dist/browser/` as it is: a server with the browser
 * client off needs none, and one with it on refuses to start until it is there.
 *
 * `node scripts/copy-browser.mjs`
 */
import { cpSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const serverDir = join(import.meta.dirname, '..');
const source = join(serverDir, '..', '..', 'apps', 'desktop', 'dist-browser');
const target = join(serverDir, 'dist', 'browser');

if (existsSync(join(source, 'index.html'))) {
  rmSync(target, { recursive: true, force: true });
  cpSync(source, target, { recursive: true });
} else {
  console.warn(
    `warning: no browser client build in ${source}; dist/browser is not updated. ` +
      'Run `pnpm --filter @wirebench/desktop build:browser` first to serve the browser tab.',
  );
}
