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
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type Plugin } from 'vite';

const here = import.meta.dirname;
const repo = resolve(here, '../..');

/**
 * Spec §17.6, verbatim. A meta tag cannot carry `frame-ancestors` (browsers ignore it there), so the
 * server sends this policy as a header too; the meta is the copy that travels with the files.
 */
export const BROWSER_CONTENT_SECURITY_POLICY =
  "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'";

/** Injects {@link BROWSER_CONTENT_SECURITY_POLICY} as a meta tag, build only, as the desktop's plugin does. */
function cspMetaPlugin(): Plugin {
  return {
    name: 'wirebench-browser-csp-meta',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        '<meta name="viewport"',
        `<meta http-equiv="Content-Security-Policy" content="${BROWSER_CONTENT_SECURITY_POLICY}" />\n    <meta name="viewport"`,
      );
    },
  };
}

/**
 * Resolves `@wirebench/<package>[/<subpath>]` to the package's sources: the `development` entry of its
 * `exports`, as the spec asks, so the build needs no `tsc -b` first. Vite's own `development` condition
 * cannot be used: it would also send `graphql` to its development build for a bare import and to the plain
 * one for a deep import, two copies whose realm checks refuse each other's schemas (see `vitest.config.ts`).
 */
function workspaceSourcesPlugin(): Plugin {
  const exportsOf = new Map<string, Record<string, unknown>>();
  return {
    name: 'wirebench-workspace-sources',
    enforce: 'pre',
    resolveId(source) {
      const match = /^@wirebench\/([a-z0-9-]+)(\/.*)?$/.exec(source);
      if (match === null) return null;
      const [, name = '', subpath = ''] = match;
      const dir = resolve(repo, 'packages', name);
      let exports = exportsOf.get(name);
      if (exports === undefined) {
        const manifest = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8')) as {
          exports?: Record<string, unknown>;
        };
        exports = manifest.exports ?? {};
        exportsOf.set(name, exports);
      }
      const key = `.${subpath}`;
      const entry = exports[key];
      if (typeof entry === 'object' && entry !== null && 'development' in entry) {
        const target = entry.development;
        if (typeof target === 'string') return resolve(dir, target);
      }
      // A wildcard export such as wire's `"./*": "./src/*.ts"`.
      const wildcard = exports['./*'];
      if (subpath !== '' && typeof wildcard === 'string') return resolve(dir, wildcard.replace('*', subpath.slice(1)));
      return null;
    },
  };
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
