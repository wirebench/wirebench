/**
 * What the renderer build is allowed to contain.
 *
 * Trimming Monaco down to the editor plus XML (see `src/renderer/editor/monaco-core.ts`) took
 * the renderer from 28 MB to under 10 MB by leaving the TypeScript, CSS, HTML and JSON language
 * services — and the four web workers behind them — out of the bundle. Nothing about that is
 * enforced by the compiler: one bare `import 'monaco-editor'` anywhere puts all four workers
 * back, silently. The same goes for keeping Monaco out of the window's startup: one static import
 * of an editor module from the shell loads all ~7 MB of it before the first paint (three such
 * imports, and Vite's preload helper filed inside Monaco's chunk, once did). So the facts are asserted
 * against the actual build output, by
 * `test/build-output.test.ts` (when the app has been built) and by the e2e global setup (which
 * requires a build in any case).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
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

/**
 * The renderer's total JavaScript budget in bytes; the trimmed build is comfortably under it.
 * 13 MB since the SSH terminal (xterm, ~0.4 MB in its own lazily loaded chunk) took the build past 12;
 * 14 MB since the SSH area's snippets, SFTP, forwarding and broadcast slices filled the last of that
 * (multi-host snippet runs, #452, crossed it by 1.5 KB). The budget is there to catch a regression the
 * size of a Monaco worker (megabytes), not a feature's kilobytes.
 */
export const RENDERER_JS_BUDGET_BYTES = 14 * 1024 * 1024;

/** What {@link inspectRendererAssets} found in a renderer build. */
export interface RendererAssets {
  /** Every file in the build, as a path relative to the renderer output directory. */
  readonly files: readonly string[];
  /** Files whose name matches one of {@link FORBIDDEN_WORKER_ASSETS}. */
  readonly forbidden: readonly string[];
  /** Total size of every `.js` file in the build. */
  readonly totalJsBytes: number;
  /**
   * Every file the window loads before its first paint: what `index.html` names (the entry script,
   * its `modulepreload`s and stylesheets) plus everything those scripts import statically.
   */
  readonly startup: readonly string[];
  /** The {@link startup} files that are Monaco's chunk (`monaco-*.js` / `monaco-*.css`). */
  readonly startupMonaco: readonly string[];
}

/** `./assets/x.js` as named in `index.html`, or `./x.js` as imported by a chunk in `assets/`. */
const HTML_ASSET = /(?:src|href)="\.\/([^"]+)"/g;
const STATIC_IMPORT = /(?:^|[;\n}])\s*import\s*(?:[^'"()]*?\bfrom\s*)?"\.\/([^"]+\.js)"/g;

/**
 * The files the window loads before it can paint. Only static `import` statements are followed —
 * a lazy `import()` is exactly what keeps a chunk out of this list.
 */
function startupFiles(dir: string): string[] {
  const html = readFileSync(join(dir, 'index.html'), 'utf8');
  const seen = new Set<string>([...html.matchAll(HTML_ASSET)].map((match) => match[1] ?? ''));
  const queue = [...seen].filter((file) => file.endsWith('.js'));
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    const folder = file.includes('/') ? file.slice(0, file.lastIndexOf('/') + 1) : '';
    for (const match of readFileSync(join(dir, file), 'utf8').matchAll(STATIC_IMPORT)) {
      const imported = `${folder}${match[1] ?? ''}`;
      if (!seen.has(imported)) {
        seen.add(imported);
        queue.push(imported);
      }
    }
  }
  return [...seen].filter((file) => file !== '');
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
  const startup = startupFiles(dir);
  return {
    files,
    startup,
    startupMonaco: startup.filter((file) => /(^|\/)monaco-[^/]*\.(js|css)$/.test(file)),
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
  if (assets.startupMonaco.length > 0) {
    throw new Error(
      `the window loads Monaco before its first paint (${assets.startupMonaco.join(', ')}); ` +
        'something the shell imports statically reaches `monaco-editor` — put it behind a `React.lazy` ' +
        'boundary or a dynamic `import()`, as the editors are',
    );
  }
  if (assets.totalJsBytes >= RENDERER_JS_BUDGET_BYTES) {
    throw new Error(
      `renderer JavaScript is ${(assets.totalJsBytes / 1024 / 1024).toFixed(1)} MB, over the ` +
        `${RENDERER_JS_BUDGET_BYTES / 1024 / 1024} MB budget`,
    );
  }
}
