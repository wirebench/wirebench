/**
 * Copies the built `@wirebench/core` and `@wirebench/protocol-*` packages into `dist/vendor/<package>` before
 * the engine is packed (package split spec §6.4, ADR-0030). The six stay private: the published engine
 * carries its own copies, which `publishConfig.imports` points the `#core` and `#protocol-…` import maps at,
 * declarations included, and lists their dependencies as its own. In the workspace each map names the
 * package itself. The same route `@wirebench/ssh` takes into the CLI (#460).
 *
 * `node scripts/vendor-packages.mjs <dir>` does the same for an engine copied out by `pnpm deploy` (the
 * CLI's and the server's container images), which applies neither `prepack` nor `publishConfig`: the
 * copies go into `<dir>/dist/vendor/` and `<dir>/package.json` takes the published `imports`.
 */
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const PACKAGES = ['core', 'protocol-soap', 'protocol-rest', 'protocol-grpc', 'protocol-ws', 'protocol-mcp'];

const engine = join(import.meta.dirname, '..');
const target = process.argv[2] === undefined ? engine : resolve(process.argv[2]);

for (const name of PACKAGES) {
  const from = join(engine, '..', name, 'dist');
  if (!existsSync(join(from, 'index.js'))) {
    throw new Error(`${from} has no index.js: build @wirebench/${name} before packing the engine`);
  }
  const to = join(target, 'dist', 'vendor', name);
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, {
    recursive: true,
    filter: (source) => !source.endsWith('.tsbuildinfo') && !source.endsWith('.d.ts.map'),
  });
}

if (target !== engine) {
  const manifestPath = join(target, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.imports = JSON.parse(readFileSync(join(engine, 'package.json'), 'utf8')).publishConfig.imports;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}
