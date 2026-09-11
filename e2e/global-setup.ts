import { existsSync } from 'node:fs';
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
}
