/**
 * The browser client's build (hosted edition spec §3.1, §17.6): the desktop renderer, built by Vite into
 * static files the server serves at `/`, with `src/browser/browser-bootstrap.ts` running first to build
 * `window.wirebench` over the server's host socket.
 *
 *   vite build -c vite.browser.config.ts   →   dist-browser/index.html, dist-browser/assets/*-<hash>.*
 *
 * It mirrors the renderer section of `electron.vite.config.ts` (aliases, plugins, the Monaco chunk) so
 * both builds bundle the same renderer; what differs is the entry, the output folder and the CSP.
 */
import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type Plugin, type Rollup } from 'vite';

const here = import.meta.dirname;
const repo = resolve(here, '../..');

/**
 * Spec §17.6, verbatim. The server sends this policy as a header; the meta tag is the copy that travels
 * with the files.
 */
export const BROWSER_CONTENT_SECURITY_POLICY =
  "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws://127.0.0.1:47615 ws://127.0.0.1:47616 ws://127.0.0.1:47617 ws://127.0.0.1:47618 ws://127.0.0.1:47619 ws://127.0.0.1:47620 ws://127.0.0.1:47621 ws://127.0.0.1:47622 ws://127.0.0.1:47623 ws://127.0.0.1:47624 ws://127.0.0.1:47625 ws://127.0.0.1:47626 ws://127.0.0.1:47627 ws://127.0.0.1:47628 ws://127.0.0.1:47629 ws://127.0.0.1:47630 ws://127.0.0.1:47631 ws://127.0.0.1:47632 ws://127.0.0.1:47633 ws://127.0.0.1:47634; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

/**
 * The meta tag's copy: the policy without `frame-ancestors`, which a meta tag cannot carry (the browser
 * ignores it there and logs an error on every load). The header holds it.
 */
export const BROWSER_META_CONTENT_SECURITY_POLICY = BROWSER_CONTENT_SECURITY_POLICY.replace(
  /;\s*frame-ancestors [^;]*/,
  '',
);

/** Injects {@link BROWSER_META_CONTENT_SECURITY_POLICY} as a meta tag, build only, as the desktop's plugin does. */
function cspMetaPlugin(): Plugin {
  return {
    name: 'wirebench-browser-csp-meta',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        '<meta name="viewport"',
        `<meta http-equiv="Content-Security-Policy" content="${BROWSER_META_CONTENT_SECURITY_POLICY}" />\n    <meta name="viewport"`,
      );
    },
  };
}

interface Manifest {
  readonly exports?: Record<string, unknown>;
  readonly imports?: Record<string, unknown>;
}

const packagesDir = resolve(repo, 'packages');
const manifests = new Map<string, Manifest>();

function manifestOf(name: string): Manifest | undefined {
  let manifest = manifests.get(name);
  if (manifest === undefined) {
    try {
      manifest = JSON.parse(readFileSync(resolve(packagesDir, name, 'package.json'), 'utf8')) as Manifest;
    } catch {
      return undefined;
    }
    manifests.set(name, manifest);
  }
  return manifest;
}

/** A map entry's target: a string, or the `development` (else `default`) branch of a conditions object. */
function targetOf(entry: unknown): string | undefined {
  if (typeof entry === 'string') return entry;
  if (typeof entry !== 'object' || entry === null) return undefined;
  const conditions = entry as Record<string, unknown>;
  return targetOf(conditions['development'] ?? conditions['default']);
}

/** Node's subpath-pattern match over an `exports` or `imports` map: an exact key, else one `*` pattern. */
function matchMap(map: Record<string, unknown>, key: string): string | undefined {
  const exact = targetOf(map[key]);
  if (exact !== undefined) return exact;
  for (const [pattern, entry] of Object.entries(map)) {
    const star = pattern.indexOf('*');
    if (star < 0) continue;
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (!key.startsWith(prefix) || !key.endsWith(suffix) || key.length < prefix.length + suffix.length) continue;
    const target = targetOf(entry);
    if (target !== undefined) return target.replaceAll('*', key.slice(prefix.length, key.length - suffix.length));
  }
  return undefined;
}

/**
 * Resolves a workspace package's own imports to its sources, so the build needs no `tsc -b` first:
 *
 * - `@wirebench/<package>[/<subpath>]` → the `development` entry of that package's `exports` (spec §17.6);
 * - `#name/...` in a file under `packages/<package>/` → that package's `imports` entry, followed through to
 *   the sources when it names another workspace package (the engine's `#core/*` is `@wirebench/core/*`).
 *
 * Anything else is `null`, left to Vite. Vite's own `development` condition cannot be used instead: it would
 * also send `graphql` to its development build for a bare import and to the plain one for a deep import, two
 * copies whose realm checks refuse each other's schemas (see `vitest.config.ts`). Without this, Vite reads
 * the `default` branch, `dist/`, which only exists where `tsc -b` has run.
 */
export function resolveWorkspaceSource(source: string, importer: string | undefined): string | null {
  if (source.startsWith('#')) {
    if (importer === undefined) return null;
    const inside = relative(packagesDir, importer.replace(/[?#].*$/, ''));
    if (inside.startsWith('..') || isAbsolute(inside)) return null;
    const name = inside.split(sep)[0] ?? '';
    const imports = manifestOf(name)?.imports;
    const target = imports === undefined ? undefined : matchMap(imports, source);
    if (target === undefined) return null;
    if (target.startsWith('@wirebench/')) return resolveWorkspaceSource(target, undefined);
    return target.startsWith('./') ? resolve(packagesDir, name, target) : null;
  }
  const match = /^@wirebench\/([a-z0-9-]+)(\/.*)?$/.exec(source);
  if (match === null) return null;
  const [, name = '', subpath = ''] = match;
  const exports = manifestOf(name)?.exports;
  const target = exports === undefined ? undefined : matchMap(exports, `.${subpath}`);
  return target === undefined ? null : resolve(packagesDir, name, target);
}

function workspaceSourcesPlugin(): Plugin {
  return {
    name: 'wirebench-workspace-sources',
    enforce: 'pre',
    resolveId(source, importer) {
      return resolveWorkspaceSource(source, importer);
    },
  };
}

/**
 * Rollup's `onwarn`: a Node module Vite "externalized for browser compatibility" is replaced by an empty
 * stand-in, so the build succeeds and the page fails when that code runs. Here it fails the build instead.
 */
export function failOnBrowserExternal(warning: Rollup.RollupLog, warn: (warning: Rollup.RollupLog) => void): void {
  if (warning.message.includes('externalized for browser compatibility')) {
    throw new Error(`browser build: ${warning.message}`);
  }
  warn(warning);
}

/**
 * Vite names the page after its place under `root` (`browser/index.html`); the server serves it at `/`.
 * `base` is `/`, so its asset URLs are absolute and do not depend on where the page sits.
 */
function pageAtRootPlugin(): Plugin {
  return {
    name: 'wirebench-browser-page-at-root',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const page = bundle['browser/index.html'];
      if (page === undefined) return;
      delete bundle['browser/index.html'];
      page.fileName = 'index.html';
      bundle['index.html'] = page;
    },
  };
}

export default defineConfig({
  // `src`, not `src/browser`: Tailwind scans the build root for class names, and the renderer lives beside
  // the bootstrap. (The desktop's root is `src/renderer`; its index.html is electron-vite's.)
  root: resolve(here, 'src'),
  base: '/',
  // No `public/` folder: everything the page loads goes through the bundle and gets a hash.
  publicDir: false,
  resolve: { alias: { '@shared': resolve(repo, 'packages/wire/src') } },
  plugins: [workspaceSourcesPlugin(), react(), tailwindcss(), cspMetaPlugin(), pageAtRootPlugin()],
  build: {
    outDir: resolve(here, 'dist-browser'),
    emptyOutDir: true,
    assetsDir: 'assets',
    rollupOptions: {
      input: resolve(here, 'src/browser/index.html'),
      onwarn: failOnBrowserExternal,
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
        // As the desktop renderer's (see `electron.vite.config.ts` for why): Monaco and Vite's preload
        // helper each get a chunk of their own, so the entry does not carry Monaco to the first paint.
        manualChunks(id: string): string | undefined {
          if (id.includes('vite/preload-helper')) {
            return 'preload-helper';
          }
          return id.includes('node_modules/monaco-editor/') ? 'monaco' : undefined;
        },
      },
    },
  },
});
