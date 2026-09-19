/**
 * Runs the recipe smoke script's `--via node` path as a child process: it builds the engine and
 * CLI, starts the demo server, and checks the four expectations documented in `cli-smoke.ts`.
 * `--via npm` and `--via docker` are exercised only in CI (`npm-smoke`, `image-smoke`), since they
 * need a network-reachable registry-style install and a `docker` daemon respectively — neither is
 * guaranteed wherever this suite runs.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('./cli-smoke.ts', import.meta.url));

describe('cli-smoke.ts --via node', () => {
  it('builds the CLI, runs it against the fixture and the demo server, and exits 0', () => {
    const output = execFileSync(process.execPath, [script, '--via', 'node'], { encoding: 'utf-8' });
    expect(output).toContain('cli-smoke --via node: ok');
  }, 120_000);
});
