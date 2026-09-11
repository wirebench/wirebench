import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import type { Plugin } from 'vite';
import { CONTENT_SECURITY_POLICY } from './src/main/security.js';

const sharedAlias = { '@shared': resolve(import.meta.dirname, 'src/shared') };

/**
 * Injects the production `Content-Security-Policy` meta tag into `index.html` — build only.
 * The dev server intentionally ships without it (see the comment in `renderer/index.html`);
 * this keeps the policy string in `security.ts` as the single source of truth for both.
 */
function cspMetaPlugin(): Plugin {
  return {
    name: 'wirebench-csp-meta',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        '<meta name="viewport"',
        `<meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}" />\n    <meta name="viewport"`,
      );
    },
  };
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: sharedAlias },
  },
  preload: {
    // `zod` must be bundled, not externalized: Electron's sandboxed preload environment can
    // only `require()` Node built-ins and `electron` itself, not arbitrary npm packages.
    plugins: [externalizeDepsPlugin({ exclude: ['zod'] })],
    resolve: { alias: sharedAlias },
    build: {
      // Electron's sandboxed preload loader only supports CommonJS, even though this
      // package is `"type": "module"` (which would otherwise default preload output to ESM).
      rollupOptions: { output: { format: 'cjs' } },
    },
  },
  renderer: {
    resolve: { alias: sharedAlias },
    plugins: [react(), tailwindcss(), cspMetaPlugin()],
    build: {
      rollupOptions: {
        output: {
          /**
           * Keep Monaco out of the entry chunk.
           *
           * Every Monaco consumer already sits behind a `React.lazy` boundary, but four of
           * those lazy chunks import it, and Rollup hoists a module shared by several dynamic
           * chunks into the common entry chunk. The effect was that `index.js` — the one script
           * the window parses before it can paint — carried all ~9 MB of Monaco, so "lazy"
           * bought nothing at startup. Naming it here makes it a sibling chunk that loads when
           * the first editor does instead.
           */
          manualChunks(id: string): string | undefined {
            return id.includes('node_modules/monaco-editor/') ? 'monaco' : undefined;
          },
        },
      },
    },
  },
});
