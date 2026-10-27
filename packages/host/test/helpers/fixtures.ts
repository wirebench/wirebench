/**
 * Repo-root fixture paths for the desktop tests.
 *
 * These used to be read as `` `${process.cwd()}/fixtures/...` ``, which silently assumed vitest
 * had been started from the repo root. It is not: `pnpm --filter @wirebench/desktop test` runs
 * with `apps/desktop` as the working directory, so every one of those reads failed with ENOENT.
 *
 * The root is found by walking up from the working directory to the workspace marker rather
 * than from `import.meta.url`: the `desktop` project runs under jsdom, where `import.meta.url`
 * is not a `file:` URL and `fileURLToPath` throws.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** Walks up from `process.cwd()` to the directory holding `pnpm-workspace.yaml`. */
function findRepoRoot(): string {
  let current = resolve(process.cwd());
  for (;;) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(`could not find the repository root above ${process.cwd()}`);
    }
    current = parent;
  }
}

/** Absolute path of the repository root, whatever directory the runner was started in. */
export const REPO_ROOT = findRepoRoot();

/** Absolute path of `fixtures/<relative>` in the repository. */
export function fixturePath(relative: string): string {
  return join(REPO_ROOT, 'fixtures', relative);
}

/** The WSDL text of the public fixture `name` (`fixtures/wsdl/public/<name>/service.wsdl`). */
export function readPublicFixture(name: string): string {
  return readFileSync(fixturePath(`wsdl/public/${name}/service.wsdl`), 'utf-8');
}

/** The WSDL text of the crafted fixture `name` (`fixtures/wsdl/crafted/<name>/service.wsdl`). */
export function readCraftedFixture(name: string): string {
  return readFileSync(fixturePath(`wsdl/crafted/${name}/service.wsdl`), 'utf-8');
}
