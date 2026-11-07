/**
 * A stand-in for the browser client's build (hosted edition spec §17.6) in a temp folder: an `index.html`,
 * one hashed asset and one unhashed one, laid out as `vite.browser.config.ts` writes them. Tests hand it to
 * `hostModule({ browserRoot })`, so none of them needs a Vite build.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerModule } from '../../src/context.js';
import { hostModule } from '../../src/host/module.js';
import { BUILTIN_MODULES } from '../../src/modules.js';
import { mkTempDir, removeTempDir } from './git.js';

/**
 * A browser build checked in beside the tests, read only: the page and one asset. For a test that starts the whole
 * server and never looks at the tab, since every server serves it and refuses to start without a build.
 */
export const STATIC_BROWSER_BUILD = fileURLToPath(new URL('../fixtures/browser-build/', import.meta.url));

/** The production module list, with the host module serving {@link STATIC_BROWSER_BUILD} in place of `dist/browser`. */
export const SERVED_MODULES: readonly ServerModule[] = BUILTIN_MODULES.map((module) =>
  module.name === 'host' ? hostModule({ browserRoot: STATIC_BROWSER_BUILD }) : module,
);

export interface BrowserBuildFixture {
  readonly root: string;
  readonly page: string;
  /** `/assets/<name>` of the hashed script. */
  readonly hashedAsset: string;
  readonly hashedBody: string;
  /** `/assets/<name>` of a file without a hash. */
  readonly plainAsset: string;
  remove(): Promise<void>;
}

export async function browserBuildFixture(): Promise<BrowserBuildFixture> {
  const root = await mkTempDir('wbs-browser-');
  const page =
    '<!doctype html><html><head><script type="module" src="/assets/index-Ab3_9-xZ.js"></script></head><body><div id="root"></div></body></html>\n';
  const hashedBody = 'console.log("the browser client");\n';
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'index.html'), page);
  await writeFile(join(root, 'assets', 'index-Ab3_9-xZ.js'), hashedBody);
  await writeFile(join(root, 'assets', 'notes.txt'), 'not hashed\n');
  await writeFile(join(root, 'assets', '.secret'), 'a dotfile\n');
  return {
    root,
    page,
    hashedAsset: '/assets/index-Ab3_9-xZ.js',
    hashedBody,
    plainAsset: '/assets/notes.txt',
    remove: () => removeTempDir(root),
  };
}
