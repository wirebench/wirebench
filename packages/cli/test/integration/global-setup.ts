import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * Builds the engine and the CLI once before the integration suite, which spawns `dist/bin.js`:
 * Node cannot run the engine's source directly (its `.js` import specifiers name files that only
 * exist after a build).
 */
export default function setup(): void {
  execFileSync('pnpm', ['--filter', '@wirebench/engine', 'build'], {
    cwd: join(import.meta.dirname, '..', '..'),
    stdio: 'inherit',
  });
  execFileSync('pnpm', ['--filter', '@wirebench/cli', 'build'], {
    cwd: join(import.meta.dirname, '..', '..'),
    stdio: 'inherit',
  });
}
