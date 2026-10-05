/**
 * Asserts that each unpacked desktop build carries the Kerberos binding for every architecture of its
 * platform that has a pinned prebuild, and that the one for this machine loads.
 *
 * There is no win32-arm64 prebuild, so nothing is required for it: the pin file is the list of what
 * must be present, and the arm64 Windows app carries the x64 binding that its loader declines to use.
 *
 *   node scripts/check-kerberos-vendor.ts <platform> <resources dir>...
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PIN_FILE = join(dirname(fileURLToPath(import.meta.url)), 'kerberos-prebuilds.json');

export function checkKerberosVendor(options: {
  readonly platform: string;
  readonly resourcesDirs: readonly string[];
  readonly loadHost: boolean;
}): string[] {
  const pins = JSON.parse(readFileSync(PIN_FILE, 'utf8')) as { prebuilds: Record<string, string> };
  const wanted = Object.keys(pins.prebuilds).filter((prebuild) => prebuild.startsWith(`${options.platform}-`));
  const problems: string[] = [];
  for (const dir of options.resourcesDirs) {
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [platform = process.platform, ...dirs] = process.argv.slice(2);
  const problems = checkKerberosVendor({ platform, resourcesDirs: dirs, loadHost: true });
  for (const problem of problems) console.error(`kerberos vendor: ${problem}`);
  if (problems.length > 0 || dirs.length === 0) process.exit(1);
  console.log(`kerberos vendor: ${dirs.length} build(s) carry every binding for ${platform}`);
}
