import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { assertRendererAssets } from '../apps/desktop/test/helpers/renderer-assets.ts';

/** The built main-process entry point every spec launches via `_electron.launch`. */
export const MAIN_PATH = fileURLToPath(new URL('../apps/desktop/out/main/index.js', import.meta.url));

/**
 * Fails fast with a clear message if the app has not been built, instead of letting every
 * spec fail individually with an opaque "file not found" from Electron.
 *
 * Also checks what that build contains: the Monaco language-service workers must stay out of it
 * and renderer JavaScript must stay under budget (see `renderer-assets.ts`). This is the one
 * place in the repo that is guaranteed to have build output, so it is where the trimmed asset
 * list is pinned; `apps/desktop/test/build-output.test.ts` asserts the same things whenever a
 * build happens to be present.
 */
export default function globalSetup(): void {
  if (!existsSync(MAIN_PATH)) {
    throw new Error(`Wirebench desktop app is not built (missing ${MAIN_PATH}). Run \`pnpm build\` first.`);
  }
  assertRendererAssets();
  ensureElectronBinary();
}

/**
 * Downloads Electron's binary now, once, if the install has not already done it.
 *
 * Electron ships no `postinstall` since v43: `require('electron')` fetches the binary the first
 * time it is asked for the path. Every worker asks at the same moment, so on a cold `node_modules`
 * five downloads unzip into the same `dist/` and trip over each other — `spawn ETXTBSY` on the
 * half-written binary, `File exists` from the extractor, and a launch failure on whichever specs
 * happened to start first. Resolving the path here, in global setup, means the download happens
 * before any worker exists; when the binary is already there this is a file check and nothing more.
 *
 * Electron is the desktop app's dependency, so it resolves from there rather than from `e2e`.
 */
function ensureElectronBinary(): void {
  const require = createRequire(import.meta.url);
  const fromDesktop = fileURLToPath(new URL('../apps/desktop/package.json', import.meta.url));
  require(require.resolve('electron', { paths: [fromDesktop] }));
}
