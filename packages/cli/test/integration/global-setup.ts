import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';

/**
 * Builds the engine and the CLI once before the integration suite, which spawns `dist/bin.js`:
 * Node cannot run the engine's source directly (its `.js` import specifiers name files that only
 * exist after a build).
 *
 * `tsc -b` is run as a script under this very Node, not through `pnpm`: on Windows `pnpm` is a
 * `pnpm.cmd` shim, which `execFile` refuses to start without a shell, and a shell is one more thing
 * whose quoting differs by OS. Both packages' `build` script starts with `tsc -b`; the CLI's then bundles
 * the agent (`scripts/bundle-agent.mjs`), which the agent tests load.
 */
export default function setup(): void {
  const repoRoot = join(import.meta.dirname, '..', '..', '..', '..');
  const tsc = createRequire(join(repoRoot, 'package.json')).resolve('typescript/bin/tsc');
  execFileSync(process.execPath, [tsc, '-b', join('packages', 'engine'), join('packages', 'cli')], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  execFileSync(process.execPath, [join('packages', 'cli', 'scripts', 'bundle-agent.mjs')], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
}
