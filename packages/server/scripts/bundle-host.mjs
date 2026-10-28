/**
 * Bundles `host-bundle/entry.ts`, with `@wirebench/host`, `@wirebench/wire` and the pure-JS packages only
 * they use, into `dist/host/bundle.js` (hosted edition spec §17.3). Both packages are source-only
 * (ADR-0033), so Node cannot load them as they are; `tsc -b` builds the rest of the server first.
 *
 * What stays external, and why:
 * - The server's own `dependencies` (the engine, `zod`, `graphql`, ...): they are in its `node_modules`
 *   at runtime anyway, and the host must share the engine's `graphql` (a schema from one copy is not a
 *   schema to another) and its WebAssembly files, which a bundle would lose.
 * - The native modules the host loads lazily, for channels the server never registers: the terminal's
 *   `@lydell/node-pty`, serial's `@serialport/*`, security keys' `node-hid`, Kerberos's `kerberos`, and
 *   any `.node` binding. They are never installed beside the server; `test/integration/host/bundle.test.ts`
 *   proves the bundle starts without them.
 *
 * `node scripts/bundle-host.mjs [outfile]`; the default is `dist/host/bundle.js`.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';

const serverDir = join(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(join(serverDir, 'package.json'), 'utf8'));
const outfile = process.argv[2] === undefined ? join(serverDir, 'dist', 'host', 'bundle.js') : resolve(process.argv[2]);

const NATIVE = ['@lydell/node-pty', '@serialport/*', 'node-hid', 'kerberos', 'cpu-features', '*.node'];

const BANNER = [
  "import { createRequire as __wbCreateRequire } from 'node:module';",
  "import { dirname as __wbDirname } from 'node:path';",
  "import { fileURLToPath as __wbFileURLToPath } from 'node:url';",
  'const require = __wbCreateRequire(import.meta.url);',
  'const __filename = __wbFileURLToPath(import.meta.url);',
  'const __dirname = __wbDirname(__filename);',
].join('\n');

/** `name` and every subpath of it (`@wirebench/engine/rest`). */
const withSubpaths = (name) => [name, `${name}/*`];

await build({
  entryPoints: [join(serverDir, 'host-bundle', 'entry.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  // `@wirebench/ssh` exports its sources under `development`; reading them there spares the build a
  // separate `tsc -b` of that package. Third-party packages see the default conditions.
  plugins: [workspaceSources(['@wirebench/ssh'])],
  external: [...Object.keys(manifest.dependencies ?? {}).flatMap(withSubpaths), ...NATIVE],
  // CommonJS packages bundled into an ES module still `require` Node's built-ins and read `__dirname`
  // (ssh2's Windows agent path).
  banner: { js: BANNER },
  // Stack traces map back to file and line; the sources themselves stay out of the image.
  sourcemap: 'linked',
  sourcesContent: false,
  logLevel: 'warning',
});

/**
 * Resolves each of `names` (a workspace package with one `.` export) to its `development` export, its
 * TypeScript sources, in the monorepo's `packages/` directory beside the server.
 */
function workspaceSources(names) {
  const sources = new Map(
    names.map((name) => {
      const dir = join(serverDir, '..', name.slice('@wirebench/'.length));
      const exports = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).exports['.'];
      return [name, join(dir, exports.development)];
    }),
  );
  return {
    name: 'workspace-sources',
    setup(builder) {
      builder.onResolve({ filter: /^@wirebench\// }, (args) => {
        const path = sources.get(args.path);
        return path === undefined ? undefined : { path };
      });
    },
  };
}
