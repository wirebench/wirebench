/**
 * Asserts that each unpacked desktop build carries exactly the Kerberos bindings its target needs, and
 * that the one for this machine loads.
 *
 * The target is `<platform>-<arch>` for a build of one architecture (Linux, Windows): it carries that
 * architecture's binding and no other. A bare `<platform>` (macOS) wants every pinned binding of the
 * platform, since the universal merge needs the x64 and arm64 apps to hold the same files. The pin
 * file is the list of what exists: there is no win32-arm64 prebuild, so that build carries none.
 *
 *   node scripts/check-kerberos-vendor.ts <platform>[-<arch>] <resources dir>...
 */

import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PIN_FILE = join(dirname(fileURLToPath(import.meta.url)), 'kerberos-prebuilds.json');

export function checkKerberosVendor(options: {
  readonly target: string;
  readonly resourcesDirs: readonly string[];
  readonly loadHost: boolean;
}): string[] {
  const pins = JSON.parse(readFileSync(PIN_FILE, 'utf8')) as { prebuilds: Record<string, string> };
  const wanted = Object.keys(pins.prebuilds).filter((prebuild) =>
    options.target.includes('-') ? prebuild === options.target : prebuild.startsWith(`${options.target}-`),
  );
  const problems: string[] = [];
  for (const dir of options.resourcesDirs) {
    const vendored = join(dir, 'kerberos');
    for (const extra of existsSync(vendored) ? readdirSync(vendored) : []) {
      if (!wanted.includes(extra))
        problems.push(`${join(vendored, extra)} is not a binding a ${options.target} build needs`);
    }
    for (const prebuild of wanted) {
      const path = join(dir, 'kerberos', prebuild, 'kerberos.node');
      if (!existsSync(path)) {
        problems.push(`${path} is missing`);
        continue;
      }
      if (options.loadHost && prebuild === `${process.platform}-${process.arch}`) {
        try {
          // A bare relative path would be looked up as a package name, so load it by absolute path.
          createRequire(import.meta.url)(resolve(path));
        } catch (error) {
          problems.push(`${path} does not load: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }
  return problems;
}

if (process.argv[1] !== undefined && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  const [target = process.platform, ...dirs] = process.argv.slice(2);
  const problems = checkKerberosVendor({ target, resourcesDirs: dirs, loadHost: true });
  for (const problem of problems) console.error(`kerberos vendor: ${problem}`);
  if (problems.length > 0 || dirs.length === 0) process.exit(1);
  console.log(`kerberos vendor: ${dirs.length} build(s) carry exactly the bindings for ${target}`);
}
