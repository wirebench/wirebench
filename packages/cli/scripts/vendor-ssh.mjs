/**
 * Copies the built `@wirebench/ssh` into `dist/vendor/ssh` before the CLI is packed. `@wirebench/ssh` stays
 * private: the published CLI carries its own copy, which `publishConfig.imports` points `#ssh` at, and lists
 * that copy's dependencies (`ssh2`, `bcrypt-pbkdf`, `node-hid`, `yaml`, `zod`) as its own. In the workspace
 * `#ssh` is the package itself.
 *
 * `node scripts/vendor-ssh.mjs <dir>` does the same for a CLI copied out by `pnpm deploy` (the container
 * image), which applies neither `prepack` nor `publishConfig`: the copy goes into `<dir>/dist/vendor/ssh` and
 * `<dir>/package.json` takes the published `imports`.
 */
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const cli = join(import.meta.dirname, '..');
const from = join(cli, '..', 'ssh', 'dist');
const target = process.argv[2] === undefined ? cli : resolve(process.argv[2]);
const to = join(target, 'dist', 'vendor', 'ssh');

if (!existsSync(join(from, 'index.js'))) {
  throw new Error(`${from} has no index.js: build @wirebench/ssh before packing the CLI`);
}
rmSync(to, { recursive: true, force: true });
cpSync(from, to, {
  recursive: true,
  filter: (source) => !source.endsWith('.d.ts') && !source.endsWith('.d.ts.map') && !source.endsWith('.tsbuildinfo'),
});

if (target !== cli) {
  const manifestPath = join(target, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.imports = JSON.parse(readFileSync(join(cli, 'package.json'), 'utf8')).publishConfig.imports;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}
