/**
 * Bundles `agent-bundle/entry.ts`, with `@wirebench/host`, `@wirebench/agent`, `@wirebench/wire`,
 * `@wirebench/ssh` and the pure-JS packages only they use, into `dist/agent/bundle.js` (hosted edition spec
 * §18.6), as the server bundles its host (`packages/server/scripts/bundle-host.mjs`). Those packages are
 * source-only (ADR-0033), so Node cannot load them as they are; `tsc -b` builds the rest of the CLI first.
 *
 * What stays external, and why:
 * - The CLI's own `dependencies` (the engine, `zod`, `graphql`, `ssh2`, ...): they are in its `node_modules`
 *   at runtime anyway, and the host must share the engine's `graphql` (a schema from one copy is not a schema
 *   to another) and its WebAssembly files, which a bundle would lose.
 * - The native modules the host loads lazily, for channels the agent never serves: the terminal's
 *   `@lydell/node-pty`, serial's `@serialport/*`, security keys' `node-hid`, and any `.node` binding. They are
 *   not installed with the CLI; `test/integration/agent-bundle.test.ts` proves the bundle starts without them.
 * - `kerberos`, which the engine loads when it is present (ADR-0019) and the agent then offers.
 *
 * `node scripts/bundle-agent.mjs [--no-sourcemap] [outfile]`; the default is `dist/agent/bundle.js`. A local
 * build keeps a source map for stack traces; `prepack` passes `--no-sourcemap`, so the published package
 * carries no map (and a map left by an earlier build is removed).
 */
import { readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';

const cliDir = join(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(join(cliDir, 'package.json'), 'utf8'));
const args = process.argv.slice(2);
const sourcemap = !args.includes('--no-sourcemap');
const target = args.find((arg) => !arg.startsWith('--'));
const outfile = target === undefined ? join(cliDir, 'dist', 'agent', 'bundle.js') : resolve(target);

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
  entryPoints: [join(cliDir, 'agent-bundle', 'entry.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  // `@wirebench/ssh` exports its sources under `development`; reading them there spares the build a
  // separate `tsc -b` of that package. Third-party packages see the default conditions.
  plugins: [workspaceSources(['@wirebench/ssh'])],
  external: [...Object.keys(manifest.dependencies ?? {}).flatMap(withSubpaths), ...NATIVE],
  // CommonJS packages bundled into an ES module still `require` Node's built-ins and read `__dirname`.
  banner: { js: BANNER },
  // Stack traces map back to file and line in a local build; the sources themselves are never in the map.
  sourcemap: sourcemap ? 'linked' : false,
  sourcesContent: false,
  logLevel: 'warning',
});
if (!sourcemap) rmSync(`${outfile}.map`, { force: true });

/**
 * Resolves each of `names` (a workspace package with one `.` export) to its `development` export, its
 * TypeScript sources, in the monorepo's `packages/` directory beside the CLI.
 */
function workspaceSources(names) {
  const sources = new Map(
    names.map((name) => {
      const dir = join(cliDir, '..', name.slice('@wirebench/'.length));
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
