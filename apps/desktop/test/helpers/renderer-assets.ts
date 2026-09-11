/**
 * What the renderer build is allowed to contain.
 *
 * Trimming Monaco down to the editor plus XML (see `src/renderer/editor/monaco-core.ts`) took
 * the renderer from 28 MB to under 10 MB by leaving the TypeScript, CSS, HTML and JSON language
 * services — and the four web workers behind them — out of the bundle. Nothing about that is
 * enforced by the compiler: one bare `import 'monaco-editor'` anywhere puts all four workers
 * back, silently. So the facts are asserted against the actual build output, by
 * `test/build-output.test.ts` (when the app has been built) and by the e2e global setup (which
 * requires a build in any case).
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './fixtures.js';

/**
 * The renderer's build output directory, resolved from the repository root rather than from
 * `import.meta.url`: the `desktop` vitest project runs under jsdom, where `import.meta.url` is
 * not a `file:` URL (see `fixtures.ts`).
 */
export const RENDERER_OUT_DIR = join(REPO_ROOT, 'apps', 'desktop', 'out', 'renderer');

/**
 * Monaco language-service workers that must not be in the build. Each is its own chunk named
 * after the worker entry point, so a substring match on the file name finds it wherever Rollup
 * decided to put it.
 */
export const FORBIDDEN_WORKER_ASSETS = ['ts.worker', 'css.worker', 'html.worker', 'json.worker'] as const;

/** The renderer's total JavaScript budget in bytes; the trimmed build is comfortably under it. */
export const RENDERER_JS_BUDGET_BYTES = 12 * 1024 * 1024;

/** What {@link inspectRendererAssets} found in a renderer build. */
export interface RendererAssets {
  /** Every file in the build, as a path relative to the renderer output directory. */
  readonly files: readonly string[];
  /** Files whose name matches one of {@link FORBIDDEN_WORKER_ASSETS}. */
  readonly forbidden: readonly string[];
  /** Total size of every `.js` file in the build. */
  readonly totalJsBytes: number;
}

/** Recursively lists `dir`, returning paths relative to it. */
function listFiles(dir: string, prefix = ''): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      found.push(...listFiles(join(dir, entry.name), relative));
    } else {
      found.push(relative);
    }
  }
  return found;
}

/** Reads a renderer build directory and reports what it holds. */
export function inspectRendererAssets(dir: string = RENDERER_OUT_DIR): RendererAssets {
  const files = listFiles(dir);
  return {
    files,
    forbidden: files.filter((file) => FORBIDDEN_WORKER_ASSETS.some((worker) => file.includes(worker))),
    totalJsBytes: files
      .filter((file) => file.endsWith('.js'))
      .reduce((total, file) => total + statSync(join(dir, file)).size, 0),
  };
}

/**
 * Throws when a renderer build breaks either rule. Used by the e2e global setup, so a build that
 * has quietly regrown the Monaco workers fails the e2e run with a clear message rather than only
 * showing up as a slower startup budget.
 */
export function assertRendererAssets(dir: string = RENDERER_OUT_DIR): void {
  const assets = inspectRendererAssets(dir);
  if (assets.forbidden.length > 0) {
    throw new Error(
      `renderer build contains Monaco language-service workers (${assets.forbidden.join(', ')}); ` +
        'only `monaco-core.ts` may pull Monaco in, and never through a bare `monaco-editor` import',
    );
  }
  if (assets.totalJsBytes >= RENDERER_JS_BUDGET_BYTES) {
    throw new Error(
      `renderer JavaScript is ${(assets.totalJsBytes / 1024 / 1024).toFixed(1)} MB, over the ` +
        `${RENDERER_JS_BUDGET_BYTES / 1024 / 1024} MB budget`,
    );
  }
}
