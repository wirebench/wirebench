import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The built main-process entry point every spec launches via `_electron.launch`. */
export const MAIN_PATH = fileURLToPath(new URL('../apps/desktop/out/main/index.js', import.meta.url));

/**
 * Fails fast with a clear message if the app has not been built, instead of letting every
 * spec fail individually with an opaque "file not found" from Electron.
 */
export default function globalSetup(): void {
  if (!existsSync(MAIN_PATH)) {
    throw new Error(`Wirebench desktop app is not built (missing ${MAIN_PATH}). Run \`pnpm build\` first.`);
  }
}
